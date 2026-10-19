# OpenCode Remote SSH

面向 **OpenCode 2 TUI** 的 SSH 插件：管理多台命名主机，让 AI 通过 `ssh_*` 工具直接操作远端 Linux，并上传、下载文件。

支持 Windows / macOS 本机，密码、私钥（含口令）、多级 ProxyJump。远端使用已有 SSH 服务，文件能力使用 SFTP，**无需安装远端辅助程序**。

## 安装

要求 OpenCode **2.0.32 或兼容的 2.x 版本**。支持直接从公开 GitHub 仓库安装。

```sh
opencode plugin add github:VibeCodingStudio/opencode-remote-ssh
```

本地开发也可以将仓库绝对路径加入全局 `~/.config/opencode/opencode.json` 的 `plugins` 数组，例如：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["D:/Temp/opencode-remote-ssh"]
}
```

合并到现有数组即可。包同时导出服务端插件和 `./tui`，OpenCode 会发现 TUI 入口。重新打开 TUI；必要时执行 `opencode service restart`。

## 使用

1. 输入 `/ssh`，选择“添加主机”。
2. 配置唯一名称、地址、端口、用户名和密码或私钥路径。
3. 需要跳板时，先保存跳板机，再在目标主机配置中选择它。跳板机自身也可以引用另一台跳板机。
4. 测试连接，分别查看 SSH 命令执行、SFTP 是否可用。
5. 在已有会话的右侧栏点击主机，选择“连接”。首次连接目录为远端用户的 `~`；也可直接通过工具传入主机 ID 建立连接。

```text
远程 SSH
  ● 开发服务器
    /home/dev/project

  ○ 测试服务器
    未连接
```

侧栏菜单只有：**连接、测试连接、断开连接**。每台主机的工作目录通过 AI 调用 `ssh_set_workspace` 修改；没有“当前目标”。

直接对 AI 说：

```text
在开发服务器的 /home/dev/project 检查启动失败的原因，同时查看测试服务器的运行状态。
把本地 D:\build\app.zip 上传到开发服务器的 /tmp/app.zip。
把远程 /var/log/app.log 下载到本地 D:\logs\app.log。
```

密码和私钥口令通过掩码 TUI 对话框输入。支持粘贴、退格、Enter 确定、Esc 取消及 Ctrl+U 清空。

## 工具

先用 `ssh_list_hosts` 获取主机的稳定 `id`。除该发现工具外，所有 `ssh_*` 工具的第一个参数均为必填的 `hostId`，不接受名称或隐式默认主机。同一会话可同时操作多台主机，每台主机的连接和工作目录独立。

| 工具 | 主要参数 |
| --- | --- |
| `ssh_list_hosts` | 无；返回各主机的 `id`、名称及本会话中的状态，不返回凭据 |
| `ssh_set_workspace` | `hostId`, `path?` |
| `ssh_shell_exec` | `hostId`, `command`, `sudo?`, `stdin?`, `timeoutMs?` |
| `ssh_list_directory` | `hostId`, `path?`, `limit?` |
| `ssh_read_file` | `hostId`, `path`, `startLine?`, `limit?` |
| `ssh_write_file` | `hostId`, `path`, `content`, `overwrite?` |
| `ssh_grep` | `hostId`, `pattern`, `path?`, `include?`, `ignoreCase?`, `limit?` |
| `ssh_glob` | `hostId`, `pattern`, `path?`, `limit?` |
| `ssh_mkdir` | `hostId`, `path`, `parents?` |
| `ssh_delete` | `hostId`, `path`, `recursive?` |
| `ssh_move` | `hostId`, `source`, `destination`, `overwrite?` |
| `ssh_upload_file` | `hostId`, `localPath`, `remotePath`, `overwrite?` |
| `ssh_download_file` | `hostId`, `remotePath`, `localPath`, `overwrite?` |
| `ssh_reset_connection` | `hostId` |

### 路径与操作语义

- 远程路径按 Linux 规则解析；`~` 指远端登录用户的家目录。相对路径基于对应主机在当前会话中的工作目录。
- 本地相对路径基于 OpenCode 会话的本地目录。上传、下载的目标参数是精确文件路径。
- 工作目录是路径解析基准，访问权限由远端执行身份及 OpenCode 的权限规则决定。
- `ssh_set_workspace` 校验目录成功后才更新指定主机的目录。shell 命令中的临时 `cd` 不改变持续工作目录。
- 覆盖文件须显式传入 `overwrite: true`；删除非空目录须 `recursive: true`；创建多级目录须 `parents: true`。
- 上传、写入、移动和下载要求父目录已经存在。
- 首版上传下载处理单个文件，支持二进制及流式大文件传输。多个文件分别调用；目录可以先打包。
- 覆盖远端文件使用 OpenSSH 的原子重命名扩展；服务器缺少相应能力时返回明确错误，不先删除原文件。
- `ssh_grep` 使用远端已有的 `grep`，表达式为扩展正则；`ssh_glob` 支持 `**`，不递归进入目录符号链接。读取和搜索均有输出上限及截断标记。
- `ssh_shell_exec` 默认超时 120 秒，`timeoutMs: 0` 禁用超时。取消和超时会尝试发送终止信号；未收到明确退出结果时，`outcome` 为 `unknown`，不可自动重放命令。

### sudo 提权

```json
{ "hostId": "从 ssh_list_hosts 返回的主机 UUID", "sudo": true, "command": "docker ps -a" }
```

- `sudo` 默认 `false`。设为 `true` 时，整个命令通过远端已有的 `sudo` 和 `sh` 以 root 执行，包括管道、重定向及临时切换工作目录；不改变会话记录的主机工作目录。
- 远端 sudo 策略需要允许运行 root shell。免密 sudo 或对本次调用有效的认证缓存无需输入密码；不支持强制交互式 TTY、OTP 等认证流程。
- 需要密码时弹出掩码 TUI 对话框。有可用的 SSH 登录密码时，可明确选择“使用此主机的 SSH 密码”；使用密钥登录时单独输入 sudo 密码。
- sudo 凭据独立缓存，默认仅在后台进程内保留；选择“记住”后使用同一本机加密存储。SSH 密码复用是确认后的独立副本，不会修改 SSH 登录凭据。
- 密码不进入工具参数、命令文本或模型返回结果。`stdin` 在提权成功后才发送给实际命令，不会与 sudo 密码输入混用。工具结果的 `elevated` 表示 root shell 是否已启动。
- 错误密码只在同一个 sudo 进程的认证阶段重新询问；命令启动后不再认证或自动重放。超时包含等待密码的时间，取消或断线会取消待处理的凭据请求。
- OpenCode 检查原始命令及其简单子命令，并单独检查 `sudo -u root -- sh -c …` 权限。Plan / Explore 仍不可执行此工具。
- `/ssh` → 对应主机 → “清除 sudo 凭据”可移除插件缓存及记住的 sudo 密码；不会清除远端 sudo 自己的认证缓存。连接身份变更后需重连，旧身份的 sudo 密码不会用于新身份。

升级到 0.2.0 后，旧的 `host` 参数及隐式当前目标不再适用。新运行时从独立状态开始；重新打开 TUI，并通过 `ssh_list_hosts` 获取 ID。若后台仍使用旧工具定义，执行 `opencode service restart`。已有主机配置和已记住的凭据继续可用，工作目录按需重新设置。

## 会话、进程和权限

- 每个会话按主机 ID 独立持有连接和工作目录。同一会话对同一主机的工具复用 SSH 连接；不同主机可并行执行，断开和重置仅影响指定主机在本会话中的连接。
- 子代理继承创建时各主机的目录快照，之后父子会话互不跟随。
- 主动断开后，普通工具不会自动重连；需要点击连接或明确调用 `ssh_set_workspace`。网络异常后可恢复连接并校验原工作目录。
- 连接相关配置的修改在下次连接时生效；侧栏标记待重连。主机名称可修改，固定 ID 不变。使用中的主机配置不能删除。
- 工作目录和临时凭据只存在 OpenCode **后台服务进程**内。关闭 TUI 不一定结束服务；服务重启后不恢复目录、不自动连接。
- Plan / Explore 使用查询和目录设置工具；写入、上传下载、任意 shell 及连接重置不向只读代理提供。其他调用显式检查 OpenCode 的 `read`、`edit`、`shell` 和本地外部目录权限。
- Shell 授权包含原始命令及可解析的简单子命令；它不是任意 shell 程序的静态副作用分析器。

## 本机数据与凭据

默认数据目录：

```text
~/.local/share/opencode-remote-ssh/
  hosts.json          主机配置，不含密码或私钥口令
  known-hosts.json     首次记录的服务器公钥指纹
  sudo-credentials.json  已记住的 sudo 凭据引用及连接身份摘要，不含密码
  credentials/        Windows 用户级 DPAPI 密文
```

可使用 `OPENCODE_REMOTE_SSH_DATA_DIR` 指定数据目录；也遵循 `XDG_DATA_HOME`。

- Windows：通过系统 Windows PowerShell 和 DPAPI `CurrentUser` 保护凭据；明文不进入进程参数或环境变量。
- macOS：使用 OpenCode 的 Bun 运行时提供的系统 Keychain 存储。
- 未勾选“记住”的凭据保留到后台服务进程退出，主动断开不会清除。
- 系统保存失败时明确提示，可以选择仅本次运行使用。
- 私钥只记录本机路径。各跳板和目标分别认证；首版不处理扫码、动态验证码或菜单式堡垒机。
- 指纹采用 accept-new：首次自动记录，后续必须匹配。变更后可在 `/ssh` 对应主机配置中重置信任记录。

## 开发与验证

建议 Node.js 26.4+、npm 和 Bun。OpenCode 运行插件使用其自带运行时。

```sh
npm ci
npm run check
npm run test:install
npm run test:tui
npm run test:tui-package
npm run test:native-tui
npm run test:sdk
npm run test:vault
npm run test:integration
```

- `check`：类型检查、配置/凭据/权限测试、构建。
- `test:install`：验证 Git 源码包无需安装时构建，并在全新消费项目中解析打包后的生产依赖。
- `test:tui`：真实 OpenTUI 测试渲染器，验证掩码输入、Unicode 粘贴退格、侧栏显示和鼠标菜单。
- `test:tui-package`：将发布包解压到独立的 `node_modules`，使用宿主同款加载器验证入口加载、侧栏渲染和点击菜单。
- `test:native-tui`：在隔离配置和数据目录中，通过伪终端启动真正的 OpenCode 2 TUI，验证 `/ssh` 能打开配置对话框、从字段输入返回后仍保持原选中项；不调用模型。
- `test:sdk`：使用 OpenCode 2.0.32 原生 SDK 验证插件加载、14 个工具注册和 RPC，不调用模型。
- `test:vault`：在 Windows / macOS 使用随机测试凭据验证系统存储，完成后删除测试条目。
- `test:integration`：需要正在运行的 Docker。创建临时 Linux OpenSSH 主机、跳板及禁用 SFTP 的主机，验证密码/密钥认证、sudo 提权与标准输入隔离、多主机并发、文件传输、目录隔离、取消和断线行为；结束后清理容器和临时凭据。

参考：[需求基线](docs/requirements.md)、[领域术语](GLOSSARY.md)、[架构决定](docs/adr/0001-remote-tools-and-process-state.md)。

TUI 发布入口是预编译的 `generated/tui.js`。修改 `src/tui` 或它引用的模块后运行 `npm run compile`，并一并提交生成文件；CI 会检查生成产物是否同步。Git 安装直接使用这个文件，安装时无需编译 JSX。
