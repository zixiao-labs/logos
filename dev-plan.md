# Logos Workstation Edition Development Plan

Stage 1: Basic Functions

Editor (Monaco Editor), File Browser, Git, Settings (GUI and JSON), Chinese/English Interface，Terminal (xterm.js), Markdown Preview, WebView, Extension Manager (with Marketplace support), Built-in Claude agent, Vim/Helix Keymap,VS Code/Cursor Layout, and more.

Stage 2: Intelligent Completion and Advanced Features

Sprint1：Access to common language servers + automatic download/update

Advanced features such as rainbow brackets and semantic search will be provided through wasm integration with Tree-sitter.

Stage 3: Extension Host

Using its own Logos JS extension and Wasm extension host, it is incompatible with VS Code, which is clean and can extend security features such as a virtual file system.

Stage 3.5: Debugging

Debug Adapter Protocol (DAP)

Built-in Node.js/Chrome/Electron adapters

Extended language support via Extension Host

Stage 4: Connectivity and Collaboration

Github/GitLab Login

~~Zixiaolabs Cloud Account Login~~ (blocked by cloud infrastructure not yet deployed)

Issue/MR Management

Pipeline Management

Deployment Management

CRDT Real-time Collaboration (P2P temporarily enabled and not yet deployed Wuling workspace (Provided by [Wuling DevOps](https://github.com/zixiao-labs/Wuling-DevOps)，requires container development functionality to be ready))

SSH and Container Development

Connect to WSL (Linux Subsystem on Windows)
