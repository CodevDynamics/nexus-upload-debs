# Nexus Upload Debs

这个GitHub Action用于将deb文件上传到Nexus仓库。它支持单个文件或整个目录的上传，并自动处理相同组件的更新。

## 功能

- 支持单个deb文件或目录批量上传
- 自动比较已存在的组件，避免重复上传
- 基于SHA256校验，仅在文件内容变化时更新
- 自动触发apt元数据重建任务（当有组件被删除时）
- 支持处理软链接文件，自动找到并上传实际文件
- 使用dpkg工具（如果可用）自动提取deb文件的精确包信息

## 输入参数

| 参数名 | 描述 | 必填 | 默认值 |
|--------|------|------|--------|
| `repository` | Nexus仓库名称 | 是 | - |
| `path` | 要上传的文件路径或目录 | 是 | `.` (当前目录) |
| `nexus_url` | Nexus服务器URL | 是 | `http://localhost:8081` |
| `nexus_user` | Nexus用户名 | 是 | `admin` |
| `nexus_password` | Nexus密码 | 是 | `admin123` |

## 使用示例

### 上传单个文件

```yaml
name: 上传deb文件到Nexus

on:
  push:
    paths:
      - '**.deb'

jobs:
  upload:
    runs-on: ubuntu-latest
    steps:
      - name: 检出代码
        uses: actions/checkout@v3

      - name: 上传deb文件
        uses: CodevDynamics/nexus-upload-debs@v1
        with:
          repository: apt-hosted
          path: './my-package.deb'
          nexus_url: ${{ secrets.NEXUS_URL }}
          nexus_user: ${{ secrets.NEXUS_USER }}
          nexus_password: ${{ secrets.NEXUS_PASSWORD }}
```

### 上传目录中的所有deb文件

```yaml
name: 上传目录中的deb文件到Nexus

on:
  push:
    branches:
      - main

jobs:
  upload:
    runs-on: ubuntu-latest
    steps:
      - name: 检出代码
        uses: actions/checkout@v3

      - name: 上传所有deb文件
        uses: CodevDynamics/nexus-upload-debs@v1
        with:
          repository: apt-hosted
          path: './dist'
          nexus_url: ${{ secrets.NEXUS_URL }}
          nexus_user: ${{ secrets.NEXUS_USER }}
          nexus_password: ${{ secrets.NEXUS_PASSWORD }}
```

## 注意事项

- 确保Nexus仓库已经创建并正确配置为apt类型
- 对于需要更新的文件，action会自动删除旧组件并上传新版本
- 建议使用GitHub Secrets存储Nexus的URL、用户名和密码
- 文件名应符合Debian包命名规范（通常为`packagename_version_arch.deb`）
- 如果遇到软链接文件，Action会自动找到并上传实际文件
- 如果运行环境中安装了dpkg工具，Action会优先使用dpkg解析deb文件的真实包信息
- 如果没有安装dpkg，将回退到使用文件名解析方式 