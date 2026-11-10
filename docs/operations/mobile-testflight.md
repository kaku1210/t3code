# T3 Code Plus：Devin 云 Mac TestFlight 出包

本流程用于这个 fork 的 iOS 内测包。身份与版本以
[`apps/mobile/ios-release.json`](../../apps/mobile/ios-release.json) 为准；目标是已有的
`Self` 内测组。上游 EAS 自动发布流程和这个 fork 的云 Mac 出包入口分别维护。

## 下次如何发起

可以直接给执行者这段指令：

> 按 `docs/operations/mobile-testflight.md`，用 Devin 云 Mac 给 T3 Code Plus 最新的已选定源码
> 出 TestFlight Self 内测包。先查 Apple 的 builds 和 buildUploads，选择未使用的新 build；
> 复用现有原生工程、Pods、DerivedData 和签名资料，按阶段续跑。沿用已授权的云端历史包清理
> 范围，保留最新出包所需内容。完成 VALID、IN_BETA_TESTING 和 Self 关系回读，下载 IPA、
> 匹配的 dSYM 和出包记录。另报真机验收状态。

执行前读取本页、`ios-release.json` 和最近一次本机 `release.json`，再做实时预检。
已经通过且输入未变的检查直接复用。正常流程连续执行到交付，遇到实际阻塞时保留阶段结果。

目前已保存的是操作流程与已验证的命令；尚没有覆盖源码同步、签名、上传、下载的通用一键脚本。
云端 `*_build_3.py` 等历史 helper 含固定版本、路径和状态，下一版使用前必须核对并更新参数。

## 常规出包的六步

1. **固定源码和版本。** 确定 Git 提交；有明确选定的未提交修改时，冻结工作树快照并记录。
   核对主 App、Widgets、Sharing 三个 target 的版本/build 一致。
2. **并行做本机检查与 Mac 预检。** 本机按实际改动检查；Mac 同时核对 Apple build 是否空闲、
   工具链、签名、原生输入与实际可写空间。满足条件后一次交接源码及完整后续任务。
3. **同步并核对源码。** 云端基线一致时只传变化文件。增量包记录旧文件预期与新文件摘要，
   覆盖前核对；基线不匹配时明确处理差异，避免把分支最新状态当成本次冻结的源码。
4. **增量归档、签名、导出。** 在已有工程与 DerivedData 上重新生成当前源码的 Release archive，
   复用已有有效签名。核对 IPA 身份、版本、生产 JS bundle、签名和匹配的符号。
5. **上传一次并完成内测分发。** 上传前再次检查 Apple builds/buildUploads，记录上传调用与结果。
   等待 `VALID`，关联已有 `Self`，确认 `IN_BETA_TESTING` 及 build/group/tester 关系。
6. **下载与留档。** 保存 IPA、dSYM、脱敏证据、来源与阶段耗时；完成传输完整性校验后交付。
   真机启动和功能验收单列，不能由上传结果代替。

## 如何复用缓存

- 固定同一 Mac 工作目录、Xcode 工具链和 `DerivedData` 路径。普通 JS/TS 修改保留原生工程、
  `node_modules`、Pods、SourcePackages 和编译缓存；输入未变时跳过 prebuild 与依赖安装。
- 对比原生依赖、lockfile、Expo 配置/plugins、原生补丁与目标设置。输入变化才处理对应安装或
  工程生成；系统工具安装/升级按现有授权边界处理。
- Expo SDK 58 默认会重新创建原生目录。已有工程需要 prebuild 时，显式使用
  `expo prebuild --platform ios --no-clean --no-install`，再按实际依赖变化处理 Pods。
- 当前发布 helper 采用无签名归档，再用已有证书与各 target profile 签名和导出。复用这个已验证
  路径，并保留完整签名验证；更换签名流程需独立核对。
- 修改过源码的新版本仍需要新的 archive。旧 IPA 不能靠替换 JS 或仅修改 build 号充当新包。

以下是已验证归档命令的参数化形式，在 Mac 的 `source/apps/mobile/ios` 中执行。
`JOB_ROOT`、`VERSION`、`BUILD` 和 `ATTEMPT` 须由本次预检确定；先加载已核对的 job 工具环境。
命令本身只归档，签名/导出、磁盘监控和 Apple 分发仍由后续阶段执行。

```sh
xcodebuild \
  -workspace T3CodePlus.xcworkspace \
  -scheme T3CodePlus \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$JOB_ROOT/Archives/T3-Code-Plus-$VERSION-$BUILD.xcarchive" \
  -derivedDataPath "$JOB_ROOT/DerivedData" \
  -clonedSourcePackagesDirPath "$JOB_ROOT/SourcePackages" \
  -disableAutomaticPackageResolution -skipPackageUpdates \
  -resultBundlePath "$JOB_ROOT/native-archive-$BUILD-attempt-$ATTEMPT.xcresult" \
  -jobs 2 \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD" \
  IPHONEOS_DEPLOYMENT_TARGET=18.0 archive
```

workspace、scheme、最低系统版本与并发数来自 1.0.0（3）的实际构建；输入变化后应重新核对。
首次出包或原生依赖变化时，需要另外预算原生工程生成、依赖恢复和缓存重建的时间与空间。

## 开工先解决空间

起跑预算包括缓存重建、archive、签名副本、导出、符号压缩与验证展开目录的峰值，以及应急预留。
1.0.0（3）曾在只剩约 1–2 GiB 时两次触发保护退出；本次成功尝试起跑可用空间约 9.48 GiB。
这是一轮实测，不能作为所有后续版本的固定空间需求。历史 700 MB 停机线只是应急保护。

空间不足时先处理已授权的历史完成产物，再评估是否能启动。核对精确路径、项目归属、活动写入
与符号链接，普通删除后测量实际回收。APFS 克隆共享数据块，目录大小相加不能代替实测。

2026-11-10 用户授权清理这台云 Mac 上各项目不再使用的旧包，以及 T3 的旧资料，保留最新出包
所需内容。该范围内的旧 IPA、xcarchive、旧符号压缩包与编译产物展开目录可按已授权范围处理；
保留源码、签名/凭据、工具和依赖、当前构建及热缓存、本机备份。实际遇到新的范围或受保护输入
时再处理授权问题。旧包删除授权不等于清除整个源工程目录。

`/Volumes/My Shared Files` 在本次实际创建目录时返回 `EPERM`。下次使用其他卷前必须做实际写入
检查，磁盘显示空闲或 writable 标记不足以证明能用于构建。

## 失败从哪个阶段续跑

| 当前结果                       | 下一步                                                              |
| ------------------------------ | ------------------------------------------------------------------- |
| 空间保护中断归档               | 保留源码、原生工程与热缓存；先恢复足够空间，再续建一个 archive 进程 |
| archive 已通过，签名或导出失败 | 复用已核对的 archive，处理实际签名/导出原因                         |
| 上传超时或结果不明确           | 先查询本次 build/upload 与已记录结果，确认后决定，避免重复上传      |
| 上传成功，Apple 正在处理       | 继续查询该 build，保留同一个 IPA 和上传记录                         |
| build VALID，但 Self 未就绪    | 只补该 build 的分发关系并回读                                       |
| TestFlight 已可用，下载失败    | 续传原产物，不重建、不重新上传                                      |
| 真机发现问题                   | 保存本次证据，修复后使用新的 build 号                               |

任务状态至少记录源码标识、版本/build、阶段开始/结束、退出码、产物路径/摘要及 Apple build ID。
上传调用前写入上传开始状态，重试先核对 Apple，避免断线后丢失“已经上传”的事实。
终止仅针对本任务记录的进程；保护同机其他构建。

## 下载、完成条件和保留内容

本机使用 `T3 Code Plus/iOS/<version>-<build>/` 存放 IPA、dSYM、artifact manifest、provenance、
脱敏证据和 `release.json`。固定记录来源源码与本次验证，避免为每个阶段重复复制完整日志。

传输摘要核对一次并复用收据。主 App 和两扩展的 dSYM UUID 必须匹配实际可执行文件；提供的框架
符号也按实际镜像匹配，不能硬编码“必须恰好 3 份/12 份”。上游缺少的符号如实记录。

大附件使用可续传下载。Devin v3 附件接口会重定向至签名下载 URL：Bearer 只发给 API；每个 Range
分块重新取得有效链接并核对响应范围，完成后核对总长和摘要。传输失败只恢复传输阶段。

完成内测出包需要同时满足：Apple `VALID`、internal `IN_BETA_TESTING`、目标 `Self` 的 build 与
既有测试者关系回读通过，以及本机产物核验通过。公开 App Store 发布、外部测试、真机验收分别
报告。凭据、keychain、证书私钥、profile 和测试者邮箱不进入 Git 或交付证据包。

云端保留当前源码、原生工程、依赖、签名资料、可复用缓存和最新出包结果。历史产物按既有授权
清理；本机旧归档备份继续保留，避免下一次临时备份大归档阻塞打包。

## 2026-11-10 的已验证基线

- 已交付版本：1.0.0（3），Self 内测组 `VALID / INTERNAL_ONLY / IN_BETA_TESTING`。
- 本次成功归档尝试：13:02:56–13:12:26（北京时间），约 9 分 30 秒；此前两次空间保护中断。
- 签名约 1.4 秒、导出约 10 秒、上传传输约 51 秒；Self 分发于 13:22:02 完成。
  这是历史阶段记录，阶段之间还包含核验与调度时间，不是下一版的耗时承诺。
- 工具：Node 26.12.1、pnpm 12.14.0、CocoaPods 1.17.0、Xcode 27.0（27A266a）；后续与当前项目
  要求及 Mac 实际环境重新对照，避免为了复用这条记录而固定过时版本。
- 云端 job 根：`/Users/devin/Library/Developer/T3CodePlusBuilds/source-only-1.0.0-1-20261108T234600Z`。
  原生目录为其下 `source/apps/mobile/ios`，工具环境为 `local-tool-env.sh`。
- 原 Devin [出包会话](https://app.devin.ai/sessions/393c791da95d4e349eae14f05cb91e5d) 复用于此工程；
  标题可能仍是旧项目名称。下次先核对会话、Mac 和上述 job 是否仍可用，再恢复任务。
- 可定位的历史 helper：`native_archive_build_3.py`、`sign_build_3_archive.py`、
  `export_build_3_archive.py`、`verify_build_3_ipa.py`、`upload_build_3_once.py`、`complete_build_3_self.py`。
  这些名称指向本次版本专用工具，不是通用发布命令。
- 本机完成记录：`D:\Project\AgentLearn\T3 Code Plus\iOS\1.0.0-3\release.json`；该目录的
  `T3-Code-Plus-1.0.0-3-sanitized-evidence.zip` 含本页耗时与阶段结论的原始记录。
- 本机旧归档备份：`D:\Project\AgentLearn\T3 Code Plus\iOS\archive-backups-20261110`，四份归档
  共 2,666 个成员的校验通过后才移除云端副本。1.0.0（3）真机功能验收尚未执行。
