# Vim / Helix 模态编辑

在设置的 **按键映射 / Keymap** 中选择 `Vim` 或 `Helix`，或设置：

```json
{ "workbench.keymap": "helix" }
```

修改立即生效。打开文件或切换模式后从 `NORMAL` 开始；状态栏显示当前模式，编辑器右下角显示待完成按键、搜索和命令行。切回 `Default` 会释放模态监听器并恢复普通输入和光标。文件编辑器、调试源码、Git diff 和多文件摘录使用同一套接入；只读视图可导航、选择、搜索和复制。

## Vim

使用 [monaco-vim](https://github.com/brijeshb42/monaco-vim) 的 CodeMirror Vim 引擎。

| 操作 | 示例 |
| --- | --- |
| 插入与返回普通模式 | `i` / `a` / `I` / `A` / `o` / `O`，`Esc` |
| 移动、计数 | `hjkl`、`w` / `b` / `e`、`gg` / `G`、`3w` |
| 操作符组合 | `dw`、`dd`、`2dd`、`ciw`、`yap` |
| 可视选择 | `v`、`V`、`Ctrl-v` |
| 撤销、重做、重复 | `u`、`Ctrl-r`、`.` |
| 寄存器与宏 | `"ayy`、`"ap`、`qa…q`、`@a` |
| 搜索与替换 | `/pattern`、`?pattern`、`n` / `N`、`:%s/old/new/g` |

这是编辑器中的 Vim 仿真，不运行 Vim/Neovim 进程、vimrc、Vimscript 或其插件；具体编辑命令兼容性以 monaco-vim 为准。

## Helix

遵循 [Helix 的选择优先交互](https://docs.helix-editor.com/keymap.html)：先形成选择，再对选择执行操作。例如 `ec` 选择到单词末尾并修改，`xd` 选择整行再删除；`d` 直接操作当前选择。

| 操作 | 按键 |
| --- | --- |
| 普通 / 插入 / 扩展选择模式 | `Esc`、`i` / `a`、`v` |
| 移动与计数 | `hjkl`、方向键、`wbe` / `WBE`、`3j`、`Home` / `End` |
| 跳转 | `gg`、`ge`、`gh`、`gl`、`gs`、`20gg`、`20G` |
| 跨行字符查找 | `f` / `t` / `F` / `T` + 字符，`Alt-.` 重复 |
| 行选择 / 全选 | `x`、`X`、`%` |
| 删除 / 修改 / 复制 / 粘贴 | `d`、`c`、`y`、`p` / `P`、`R` |
| 指定寄存器 / 系统剪贴板 | `"` + 寄存器；`Space y`、`Space p` / `Space P` |
| 行首尾插入 / 新行 | `I`、`A`、`o` / `O` |
| 撤销 / 重做 / 重复插入 | `u`、`U`、`.` |
| 替换字符 / 大小写 | `r` + 字符、`~`、反引号 |
| 文本对象 | `mi` / `ma` + `w` / `W` / `p` / 括号 / 引号 |
| 包围选择 / 匹配括号 | `ms` + 字符、`mm` |
| 正则多选 / 分割 / 筛选 | `s`、`S`、`K`，输入正则并回车；`Alt-s` 按行分割 |
| 多光标 | `C` 添加下一行选择；`,` 保留主选择；`(` / `)` 切换主选择 |
| 收缩 / 反转 / 去空白 | `;`、`Alt-;`、`_` |
| 搜索 | `/` / `?`、`n` / `N`；`*` 将当前选择设为搜索词 |
| 缩进 / 格式化 / 合并行 | `>` / `<`、`=`、`J` |
| 注释 / 页面移动 | `Ctrl-c`、`Ctrl-b` / `Ctrl-f`、`Ctrl-u` / `Ctrl-d` |
| 语言服务 | `gd` / `gy` / `gr` / `gi`、`Space k` / `Space r` / `Space a` |

扩展选择模式下，移动延长选择，`n` / `N` 追加搜索匹配。修改与随后的插入组成一次撤销；编辑按 Unicode 字素边界处理，保留组合字符、emoji 和 CRLF 换行。`.` 重复上次插入入口及插入文本；不重放插入过程中对插入区域以外的删除。

Helix 模式目前覆盖上述编辑命令，不加载 Helix 配置、tree-sitter 语法对象、shell 管道、窗口布局命令或 Helix 宏。语言服务快捷键依赖当前文件的 LSP；视图和窗口管理仍使用 Logos。

## 文件命令与快捷键

两种模式都支持 `:w` / `:write`、`:q` / `:quit`、`:wq`、`:x` / `:xit`、`:bn` / `:bnext`、`:bp` / `:bprevious`。Helix 支持 `:行号`。

保存和关闭复用 Logos 的磁盘冲突与未保存修改处理。`:wq` 只在保存成功后关闭；`:q` 会进入现有未保存修改确认流程。命令不接受另存路径或强制覆盖参数。

`Cmd-s` / `Ctrl-s` 保存；macOS 的 `Cmd` 工作台快捷键保留。编辑器内的模态 `Ctrl` 命令优先，例如 `Ctrl-b` 用于翻页；在搜索框、设置和终端中仍使用对应组件的按键行为。插入模式保留 Monaco 的输入法与补全。

## 验证

```sh
npm test -- src/lib/helix-selection.test.ts src/i18n/locales.test.ts
npm run test:e2e -- e2e/editor-keymap.e2e.test.tsx
npm run typecheck
npm run build
```

浏览器测试直接创建 Monaco，覆盖两种模式的编辑、撤销、搜索、只读保护、保存失败、模型切换和销毁。新增输入类测试应走 DOM 键盘事件，避免直接调用模态引擎绕过事件路由。
