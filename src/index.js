const core = require('@actions/core');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const FormData = require('form-data');
const { promisify } = require('util');
const readdirAsync = promisify(fs.readdir);
const statAsync = promisify(fs.stat);
const readFileAsync = promisify(fs.readFile);
const readlinkAsync = promisify(fs.readlink);
const lstatAsync = promisify(fs.lstat);
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

// 全局变量
let hasDeletedComponent = false;

/**
 * 生成SHA256哈希值
 * @param {Buffer} data 文件数据
 * @returns {string} SHA256哈希值
 */
function generateSHA256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * 检查是否为软链接并获取实际文件路径
 * @param {string} filePath 文件路径
 * @returns {Promise<string>} 实际文件路径
 */
async function getActualFilePath(filePath) {
  try {
    const stats = await lstatAsync(filePath);
    if (stats.isSymbolicLink()) {
      // 解析软链接指向的实际路径
      const targetPath = await readlinkAsync(filePath);
      
      // 如果目标路径是相对路径，则计算绝对路径
      if (!path.isAbsolute(targetPath)) {
        const dirName = path.dirname(filePath);
        return path.resolve(dirName, targetPath);
      }
      
      return targetPath;
    }
    
    // 如果不是软链接，返回原始路径
    return filePath;
  } catch (error) {
    console.error(`获取文件实际路径失败: ${error.message}`);
    return filePath; // 失败时返回原始路径
  }
}

/**
 * 使用dpkg解析deb文件的包信息
 * @param {string} filePath deb文件路径
 * @returns {Promise<Object>} 包含name, group, version的对象
 */
async function getDebInfoWithDpkg(filePath) {
  try {
    // 使用dpkg -I命令提取deb包信息
    const { stdout } = await execAsync(`dpkg -I "${filePath}"`);
    
    // 解析包名
    const packageMatch = stdout.match(/Package:\s*(.+)/i);
    const name = packageMatch ? packageMatch[1].trim() : null;
    
    // 解析版本
    const versionMatch = stdout.match(/Version:\s*(.+)/i);
    const version = versionMatch ? versionMatch[1].trim() : null;
    
    // 解析架构
    const archMatch = stdout.match(/Architecture:\s*(.+)/i);
    const arch = archMatch ? archMatch[1].trim() : null;
    
    if (name && version && arch) {
      console.log(`使用dpkg提取的信息 - 名称: ${name}, 版本: ${version}, 架构: ${arch}`);
      return {
        name: name,
        group: arch,
        version: version
      };
    } else {
      console.warn('使用dpkg无法获取完整的包信息，将回退到文件名解析');
      return extractInfoFromFilename(filePath);
    }
  } catch (error) {
    console.warn(`使用dpkg解析deb文件信息失败: ${error.message}`);
    console.warn('回退到文件名解析');
    return extractInfoFromFilename(filePath);
  }
}

/**
 * 从deb文件名提取包名、组和版本信息
 * @param {string} filename 文件名
 * @returns {Object} 包含name, group, version的对象
 */
function extractInfoFromFilename(filename) {
  const basename = path.basename(filename, '.deb');
  
  // 使用标准解析方式，基于下划线分割：packagename_version_arch.deb
  const parts = basename.split('_');
  const name = parts[0];
  
  // 最后一部分通常是架构（如amd64），作为group
  const group = parts[parts.length - 1];
  
  // 中间部分是版本（减去name和group部分）
  let version = '';
  if (parts.length > 2) {
    version = parts.slice(1, parts.length - 1).join('_');
  }
  
  console.log(`从文件名提取的信息 - 名称: ${name}, 组: ${group}, 版本: ${version}`);
  return {
    name: name || '-',
    group: group || '-',
    version: version || '-'
  };
}

/**
 * 获取组件列表
 * @param {Object} config Axios配置
 * @param {string} repository 仓库名称
 * @returns {Promise<Array>} 组件列表
 */
async function getComponents(config, repository) {
  try {
    console.log('获取当前仓库中的组件列表...');
    
    const components = [];
    let continuationToken = null;
    
    do {
      let url = `${config.baseURL}/service/rest/v1/components?repository=${repository}`;
      if (continuationToken) {
        url += `&continuationToken=${continuationToken}`;
      }
      
      const response = await axios.get(url, config);
      
      if (response.data.items && response.data.items.length > 0) {
        for (const item of response.data.items) {
          const id = item.id;
          const name = item.name;
          const group = item.group || '-';
          const version = item.version || '-';
          let sha256 = '-';
          
          if (item.assets && item.assets.length > 0 && 
              item.assets[0].checksum && item.assets[0].checksum.sha256) {
            sha256 = item.assets[0].checksum.sha256;
          }
          
          components.push({
            id,
            name,
            group,
            version,
            sha256
          });
        }
      }
      
      continuationToken = response.data.continuationToken;
    } while (continuationToken);
    
    console.log(`找到 ${components.length} 个组件`);
    return components;
    
  } catch (error) {
    console.error('获取组件列表失败:', error.message);
    if (error.response) {
      console.error('响应状态:', error.response.status);
      console.error('响应数据:', error.response.data);
    }
    throw error;
  }
}

/**
 * 删除组件
 * @param {Object} config Axios配置
 * @param {string} id 组件ID
 * @returns {Promise<boolean>} 是否成功
 */
async function deleteComponent(config, id) {
  try {
    console.log(`删除组件: ${id}`);
    
    const response = await axios.delete(
      `${config.baseURL}/service/rest/v1/components/${id}`,
      config
    );
    
    if (response.status === 204) {
      console.log(`组件删除成功: ${id}`);
      hasDeletedComponent = true;
      return true;
    } else {
      console.error(`组件删除失败，状态码: ${response.status}`);
      return false;
    }
  } catch (error) {
    console.error('删除组件失败:', error.message);
    if (error.response) {
      console.error('响应状态:', error.response.status);
      console.error('响应数据:', error.response.data);
    }
    return false;
  }
}

/**
 * 上传组件
 * @param {Object} config Axios配置
 * @param {string} repository 仓库名称
 * @param {string} filePath 文件路径
 * @returns {Promise<boolean>} 是否成功
 */
async function uploadComponent(config, repository, filePath) {
  try {
    console.log(`上传文件: ${filePath} 到仓库 ${repository}`);
    
    const formData = new FormData();
    const fileContent = await readFileAsync(filePath);
    
    // 添加文件到formData
    formData.append('apt.asset', fileContent, {
      filename: path.basename(filePath),
      contentType: 'application/x-deb'
    });
    
    // 添加其他必要字段
    formData.append('apt.asset.filename', path.basename(filePath));
    
    const uploadConfig = { ...config };
    uploadConfig.headers = {
      ...uploadConfig.headers,
      ...formData.getHeaders(),
      'Content-Type': 'multipart/form-data'
    };
    
    const response = await axios.post(
      `${config.baseURL}/service/rest/v1/components?repository=${repository}`,
      formData,
      uploadConfig
    );
    
    if (response.status === 204) {
      console.log(`文件上传成功: ${filePath}`);
      return true;
    } else {
      console.error(`文件上传失败，状态码: ${response.status}`);
      return false;
    }
  } catch (error) {
    console.error('上传组件失败:', error.message);
    if (error.response) {
      console.error('响应状态:', error.response.status);
      console.error('响应数据:', error.response.data);
    }
    return false;
  }
}

/**
 * 执行apt元数据重建任务
 * @param {Object} config Axios配置
 * @returns {Promise<boolean>} 是否成功
 */
async function runRebuildAptMetadata(config) {
  try {
    console.log('尝试执行apt元数据重建任务...');
    
    // 获取任务列表
    const tasksResponse = await axios.get(
      `${config.baseURL}/service/rest/v1/tasks`,
      config
    );
    
    if (tasksResponse.status !== 200) {
      console.error(`获取任务列表失败，状态码: ${tasksResponse.status}`);
      return false;
    }
    
    // 查找apt元数据重建任务
    const aptTask = tasksResponse.data.items.find(
      item => item.type === 'repository.apt.rebuild.metadata'
    );
    
    if (!aptTask) {
      console.warn('未找到apt元数据重建任务。');
      return false;
    }
    
    console.log(`找到apt元数据重建任务ID: ${aptTask.id}`);
    
    // 执行任务
    const runConfig = { ...config };
    runConfig.headers = {
      ...runConfig.headers,
      'Content-Type': 'application/json'
    };
    
    const runResponse = await axios.post(
      `${config.baseURL}/service/rest/v1/tasks/${aptTask.id}/run`,
      {},
      runConfig
    );
    
    if (runResponse.status === 204) {
      console.log('apt元数据重建任务已成功启动');
      return true;
    } else {
      console.error(`apt元数据重建任务启动失败，状态码: ${runResponse.status}`);
      return false;
    }
  } catch (error) {
    console.error('执行apt元数据重建任务失败:', error.message);
    if (error.response) {
      console.error('响应状态:', error.response.status);
      console.error('响应数据:', error.response.data);
    }
    return false;
  }
}

/**
 * 处理单个文件
 * @param {Object} config Axios配置
 * @param {string} repository 仓库名称
 * @param {string} filePath 文件路径
 * @param {Array} components 组件列表
 * @returns {Promise<void>}
 */
async function processSingleFile(config, repository, filePath, components) {
  try {
    // 解析软链接，获取实际文件路径
    const actualFilePath = await getActualFilePath(filePath);
    if (actualFilePath !== filePath) {
      console.log(`文件 ${filePath} 是软链接，实际文件路径: ${actualFilePath}`);
    }
    
    const filename = path.basename(actualFilePath);
    console.log(`处理文件: ${filename}`);
    
    // 使用dpkg提取deb文件信息，如果失败则回退到文件名解析
    const fileInfo = await getDebInfoWithDpkg(actualFilePath);
    
    // 计算文件的SHA256值
    const fileData = await readFileAsync(actualFilePath);
    const fileSha256 = generateSHA256(fileData);
    console.log(`文件SHA256: ${fileSha256}`);
    
    // 标记是否需要上传
    let needUpload = true;
    
    // 查找匹配的组件并删除
    for (const comp of components) {
      // 比较name、group和version是否匹配
      if (comp.name === fileInfo.name && 
          (comp.group === fileInfo.group || comp.group === '-' || fileInfo.group === '-') && 
          (comp.version === fileInfo.version || comp.version === '-' || fileInfo.version === '-')) {
        
        console.log(`找到匹配的组件: 名称=${comp.name}, 组=${comp.group}, 版本=${comp.version}, ID=${comp.id}, SHA256=${comp.sha256}`);
        
        // 检查SHA256是否匹配
        if (comp.sha256 === fileSha256) {
          console.log('SHA256校验值匹配，无需重新上传');
          needUpload = false;
        } else {
          console.log('SHA256校验值不匹配，需要删除并重新上传');
          await deleteComponent(config, comp.id);
        }
      }
    }
    
    // 上传文件（如果需要）
    if (needUpload) {
      await uploadComponent(config, repository, actualFilePath);
    }
  } catch (error) {
    console.error(`处理文件 ${filePath} 失败:`, error.message);
    throw error;
  }
}

/**
 * 主函数
 */
async function run() {
  try {
    // 获取输入参数 - 所有参数都是必填的
    const repository = core.getInput('repository', { required: true });
    const uploadPath = core.getInput('path', { required: true });
    const nexusUrl = core.getInput('nexus_url', { required: true });
    const nexusUser = core.getInput('nexus_user', { required: true });
    const nexusPassword = core.getInput('nexus_password', { required: true });
    
    console.log(`仓库: ${repository}`);
    console.log(`路径: ${uploadPath}`);
    console.log(`Nexus URL: ${nexusUrl}`);
    
    // 生成随机的CSRF令牌
    const csrfToken = `0.${Date.now()}${Math.floor(Math.random() * 9000000 + 1000000)}`;
    
    // Axios配置
    const config = {
      baseURL: nexusUrl,
      auth: {
        username: nexusUser,
        password: nexusPassword
      },
      headers: {
        'NX-ANTI-CSRF-TOKEN': csrfToken,
        'X-Nexus-UI': 'true',
        'accept': 'application/json'
      }
    };
    
    // 获取当前仓库中的组件
    const components = await getComponents(config, repository);
    
    // 检查是否安装了dpkg
    try {
      await execAsync('dpkg --version');
      console.log('检测到dpkg已安装，将使用dpkg解析deb文件信息');
    } catch (error) {
      console.warn('未安装dpkg，将仅使用文件名来解析deb包信息');
    }
    
    // 检查路径是文件还是目录
    const stats = await statAsync(uploadPath);
    
    if (stats.isFile()) {
      // 处理单个文件
      if (uploadPath.toLowerCase().endsWith('.deb')) {
        await processSingleFile(config, repository, uploadPath, components);
      } else {
        console.error(`错误: 文件 '${uploadPath}' 不是deb文件`);
        core.setFailed(`文件 '${uploadPath}' 不是deb文件`);
        return;
      }
    } else if (stats.isDirectory()) {
      // 处理目录
      console.log(`准备上传目录 ${uploadPath} 中的所有deb文件`);
      
      // 读取目录中的所有文件
      const files = await readdirAsync(uploadPath);
      const debFiles = files.filter(file => file.toLowerCase().endsWith('.deb'));
      
      console.log(`找到 ${debFiles.length} 个deb文件`);
      
      // 处理每个deb文件
      for (const file of debFiles) {
        const filePath = uploadPath === '.' ? file : path.join(uploadPath, file);
        await processSingleFile(config, repository, filePath, components);
      }
    } else {
      console.error(`错误: 路径 '${uploadPath}' 既不是文件也不是目录`);
      core.setFailed(`路径 '${uploadPath}' 既不是文件也不是目录`);
      return;
    }
    
    console.log('上传处理完成');
    
    // 在所有操作完成后，仅当执行过删除组件操作时才执行apt元数据重建任务
    if (hasDeletedComponent) {
      console.log('检测到有组件被删除，执行apt元数据重建任务...');
      await runRebuildAptMetadata(config);
    }
    
    core.setOutput('result', '上传成功');
  } catch (error) {
    console.error('执行失败:', error.message);
    core.setFailed(error.message);
  }
}

run(); 