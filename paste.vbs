' Sends Ctrl+V to the foreground window. cscript starts far faster than
' PowerShell, which matters between "transcribed" and "text appears".
CreateObject("WScript.Shell").SendKeys "^v"
