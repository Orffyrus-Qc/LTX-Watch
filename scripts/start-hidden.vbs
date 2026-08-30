Option Explicit
Dim fso, sh, root, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(root)
sh.CurrentDirectory = root
cmd = "cmd.exe /c set LTX_WATCH_API_PORT=4312&& set LTX_WATCH_SITE_PORT=3001&& set NEXT_PUBLIC_LTX_WATCH_API=http://127.0.0.1:4312&& node scripts\run-local.mjs dev"
sh.Run cmd, 0, False
