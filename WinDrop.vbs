' WinDrop simgesini pencere acmadan baslatir.
Option Explicit
Dim sh, fso, dir, args, i
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
args = ""
For i = 0 To WScript.Arguments.Count - 1
  If WScript.Arguments(i) = "-Panel" Then args = args & " -Panel"
Next
sh.CurrentDirectory = dir
sh.Run "powershell -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & dir & "\tray.ps1""" & args, 0, False
