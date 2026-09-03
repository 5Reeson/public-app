#!/bin/bash

set -u

app_path="/Applications/图渡.app"
settings_url="x-apple.systempreferences:com.apple.preference.security?General"

open_privacy_settings() {
  /usr/bin/open "$settings_url" 2>/dev/null || \
    /usr/bin/open "/System/Library/PreferencePanes/Security.prefPane"
}

pause_before_exit() {
  printf '\n按回车键关闭窗口…'
  read -r _
}

clear
printf '%s\n\n' '图渡 — 首次打开修复工具'
printf '%s\n' '此工具只会移除“图渡.app”的 macOS 下载隔离标记。'
printf '%s\n' '不会关闭系统安全功能，也不会联网或修改其他应用。'
printf '\n目标应用：%s\n' "$app_path"

if [[ ! -d "$app_path" ]]; then
  printf '\n%s\n' '尚未找到图渡。请先将图渡拖入 Applications 文件夹。'
  pause_before_exit
  exit 1
fi

printf '\n%s\n' '按回车自动修复；输入 S 仅打开“隐私与安全性”设置：'
read -r choice

if [[ "$choice" == "s" || "$choice" == "S" ]]; then
  open_privacy_settings
  exit 0
fi

printf '\n即将执行：\n  xattr -dr com.apple.quarantine "%s"\n\n' "$app_path"

if /usr/bin/xattr -dr com.apple.quarantine "$app_path" 2>/dev/null; then
  printf '%s\n' '修复完成，正在打开图渡…'
  /usr/bin/open "$app_path"
  exit 0
fi

printf '%s\n' '需要管理员权限。请输入当前 macOS 账号的登录密码。'
if /usr/bin/sudo /usr/bin/xattr -dr com.apple.quarantine "$app_path"; then
  printf '\n%s\n' '修复完成，正在打开图渡…'
  /usr/bin/open "$app_path"
  exit 0
fi

printf '\n%s\n' '自动修复失败，正在打开“隐私与安全性”设置。'
printf '%s\n' '请在“安全性”区域找到图渡并点击“仍要打开”。'
open_privacy_settings
pause_before_exit
exit 1
