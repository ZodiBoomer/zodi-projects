Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
rootDir = fso.GetParentFolderName(scriptDir)
cmdPath = rootDir & "\tools\start-local.cmd"
logPath = rootDir & "\electron\ui.log"

On Error Resume Next
Set logFile = fso.OpenTextFile(logPath, 8, True)
logFile.WriteLine Now & " - start-local-hidden.vbs lance ZodiBot local"
logFile.Close
On Error GoTo 0

shell.Run """" & cmdPath & """", 0, False
