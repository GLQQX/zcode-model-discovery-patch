# ZCode Model Discovery Patch

给 [ZCode](https://z.ai)（Windows 桌面版）添加「拉取模型」功能的补丁器。

在 ZCode 的模型供应商设置中填好 Base URL 和 API Key 后，可一键从供应商的 OpenAI-compatible `/v1/models` 接口拉取模型列表，自动填入模型配置，并补全元数据：

- 上下文窗口 / 最大输出 token（优先取供应商返回，缺失时从 [models.dev](https://models.dev) 公共目录查询）
- 视觉 / 多模态输入能力
- 已手工调整过的模型字段不会被覆盖

ZCode 官方自动更新替换 `app.asar` 后，补丁器会在下次登录时自动检测并重新应用补丁；新版界面结构不兼容时保持官方文件不动，安全失败。

## 安装

1. 安装并至少启动过一次 ZCode。
2. 下载 `ZCodeModelDiscoveryPatch-Setup.exe`（见 [Releases](../../releases)），双击运行。
   - 未签名 exe 会触发 SmartScreen 警告，选「更多信息 → 仍要运行」。
3. 安装器自动定位 ZCode 安装目录（找不到时支持 `-ZCodeAsar <路径>` 参数指定 `app.asar`），备份官方包、打补丁，并注册用户级登录计划任务 `ZCode Model Discovery Patch`。
4. 重启 ZCode 即可看到「拉取模型」按钮。

不需要管理员权限，不需要 Node.js / npm（安装器自带运行时）。

## 卸载 / 恢复官方原版

在 `%USERPROFILE%\.zcode-model-discovery-patch` 目录（ZCode 需关闭）：

```powershell
# 1. 恢复官方 app.asar
node.exe apply-patch.mjs --restore --json

# 2. 删除计划任务与补丁器运行时（保留备份和日志）
powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1
```

## 安全设计

- 每个官方版本一份备份（`backups/<官方SHA256>.asar`），支持 `--restore` 完整恢复。
- 应用补丁前依次执行：锚点唯一性校验 → 变换 → `node --check` 语法检查 → 重新封包 → 二次读取验证 → 安装后哈希比对；任一步失败即放弃，不触碰官方文件。
- 目标文件被占用（ZCode 运行中）时记录 `pending`，下次计划任务重试，不强杀进程。
- API Key 只发送给用户自己填写的供应商地址；查询 models.dev 时仅发送模型名。

## 从源码构建

```powershell
cd zcode-patcher
npm ci
powershell -NoProfile -ExecutionPolicy Bypass -File build-installer.ps1
# 产物: dist/ZCodeModelDiscoveryPatch-Setup.exe
```

运行测试：

```powershell
# 补丁器单元测试
node --test test/

# 安装/卸载脚本隔离测试
powershell -NoProfile -ExecutionPolicy Bypass -File test/install-script.test.ps1
```

## 仓库结构

```
zcode-patcher/
  apply-patch.mjs        # 补丁主流程：检测、解包、安装、恢复
  lib/transform.mjs      # 渲染器/主进程 bundle 的确定性变换
  lib/state.mjs          # 状态文件与路径安全
  payload/model-discovery.js  # 注入的模型发现实现（版本化）
  install.ps1 / setup.ps1 / build-installer.ps1 / uninstall.ps1
docs/superpowers/        # 设计文档与实施计划
zcode-tests/             # 模型发现逻辑测试
```

## 已知限制

- 仅支持 OpenAI-compatible 供应商的 `/models` 接口。
- 仅在 Windows 10 x64 上测试过。
- ZCode 大版本更新若重构设置界面，补丁会安全跳过，需更新锚点后发新补丁版本。

## 免责声明

本项目修改 ZCode 应用本体的界面代码，与 ZCode 官方无关。使用风险自负；如遇问题可用 `--restore` 恢复官方原版。
