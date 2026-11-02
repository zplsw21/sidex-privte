# Thief-Book for SideX

基于本机 `C-TEAM.thief-book` 0.0.9 的 SideX 适配版，插件 ID 保持 `C-TEAM.thief-book`，版本为 `0.0.11`。沿用四个命令、五项配置、原版快捷键及中文 / 英文分页与换行处理，新增老板键备用快捷键，不增加第三方依赖。

原项目：https://github.com/cteams/Thief-Book-VSCode

## 环境要求

使用 Node 扩展宿主运行，需要 SideX 支持 `window.createStatusBarItem` 及其前端状态栏消息桥接。未经修复的 SideX 0.1.2 将这些 API 留为空实现，安装插件后也不会显示文本。此适配使用持久状态栏项目，不依赖 SideX 中仍为空实现的 `setStatusBarMessage`。

## 使用

在 SideX 设置中填写 `thiefBook.filePath`，指向本机 UTF-8 TXT 文件。书籍正文只从本机读取，不通过网络传输，也不写入日志。

| 设置 | 默认值 | 含义 |
| --- | --- | --- |
| `thiefBook.filePath` | 空字符串 | TXT 文件绝对路径 |
| `thiefBook.currPageNumber` | `1` | 初始页码或修改后的跳转目标 |
| `thiefBook.pageSize` | `50` | 每页字符数，与原版一致按 JavaScript 字符串长度计算 |
| `thiefBook.isEnglish` | `false` | 开启后每页字符数翻倍 |
| `thiefBook.lineBreak` | 一个空格 | 替换 TXT 中的换行符 |

| 命令 | Mac 默认键 | Windows / Linux 默认键 |
| --- | --- | --- |
| `thief-book.DisplayCode` | `Ctrl+Option+M`（推荐）；`Cmd+M`（原键） | `Ctrl+Alt+M`（备用）；`Ctrl+M`（原键） |
| `thief-book.PreviousBook` | `Cmd+,` | `Ctrl+Alt+,` |
| `thief-book.NextBook` | `Cmd+.` | `Ctrl+Alt+.` |
| `thief-book.JumpingBook` | `Cmd+;` | `Ctrl+Alt+;` |

Mac 上推荐用 `Ctrl+Option+M` 作为老板键（配置中写作 `ctrl+alt+m`）；原有 `Cmd+M` 保留，但可能被 SideX 的原生菜单或 macOS 作为最小化窗口处理。备用键无需修改 SideX 菜单，也不要求编辑器获得焦点。

上一页和下一页的原快捷键保留，在编辑器获得焦点时生效。若与其他快捷键冲突，可以从命令面板执行，或在键盘快捷键设置中重新绑定。

`DisplayCode` 为老板键，立即把状态栏内容替换为随机语言的 Hello World，不改变阅读进度。首次执行下一页会从配置页码翻到下一页，与原版一致；希望先显示第 1 页时执行 `JumpingBook`。

## 阅读进度与跳转

SideX 0.1.2 的配置更新和 `globalState` 不保证写入磁盘，因此适配版使用扩展的全局存储目录下的 `progress.json` 保存当前书籍路径、页码和配置页码快照，原子替换写入。文件不包含正文。SideX 的该目录通常位于扩展目录的 `.global-storage`；实际路径由宿主的 `globalStorageUri` / `globalStoragePath` 决定。

设置里的页码未变化时，三个阅读命令都使用保存的进度；页码设置发生变化，则采用新设置。切换文件后从该文件的配置页码开始。重启后执行 `JumpingBook` 可显示上次阅读页，上一页或下一页继续翻页。

跳转时先修改 `thiefBook.currPageNumber`，再执行 `JumpingBook`。插件不改写用户设置文件，当前进度显示在状态栏。因此设置仍为 `1`、但进度已到第 10 页时，直接执行 `JumpingBook` 会显示第 10 页；要明确跳回第 1 页，可先把设置改为其他页码，再改回 `1`，再执行跳转。SideX 需将实时配置变化同步给扩展宿主；应用关闭期间把配置改为与原值相同的值无法被识别为跳转请求。超过总页数的目标被限制到末页，非正数或非有限的页码 / 每页字符数使用默认值。

## 验证

```sh
npm test
```

测试使用 Node 自带的测试框架、模拟的 VS Code API 和临时 TXT / 存储目录；覆盖五条快捷键声明及备用老板键的命令关联、实际命令与状态栏更新、翻页首尾、重启恢复、设置跳转、英文与换行处理、默认值、读写失败和老板键。物理按键仍需在 SideX 中实际验证。测试不会读取用户书籍或写入用户设置。
