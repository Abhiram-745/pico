// Runtime only: never persist API keys in configuration files or command arguments.
import { spawn } from 'node:child_process';
const source = `
using System; using System.Runtime.InteropServices; using System.Text;
public class HaloCredential {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Credential { public uint Flags; public uint Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
 [DllImport("advapi32.dll",EntryPoint="CredWriteW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Write(ref Credential c,uint flags);
 [DllImport("advapi32.dll",EntryPoint="CredReadW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Read(string target,uint type,uint flags,out IntPtr ptr);
 [DllImport("advapi32.dll")] static extern void CredFree(IntPtr ptr);
 public static void Save(string target, string value) { var bytes=Encoding.Unicode.GetBytes(value); var ptr=Marshal.AllocHGlobal(bytes.Length); try { Marshal.Copy(bytes,0,ptr,bytes.Length); var c=new Credential { Type=1,TargetName=target,UserName="Halo",CredentialBlobSize=(uint)bytes.Length,CredentialBlob=ptr,Persist=2 }; if(!Write(ref c,0)) throw new Exception("Credential save failed"); } finally { for(int i=0;i<bytes.Length;i++) Marshal.WriteByte(ptr,i,0); Marshal.FreeHGlobal(ptr); Array.Clear(bytes,0,bytes.Length); } }
 public static string Load(string target) { IntPtr ptr; if(!Read(target,1,0,out ptr)) return ""; try { var c=(Credential)Marshal.PtrToStructure(ptr,typeof(Credential)); return Marshal.PtrToStringUni(c.CredentialBlob,(int)c.CredentialBlobSize/2); } finally { CredFree(ptr); } }
}`;
export function credential(target, action, key = '') {
  if (!['Halo/Composio', 'Halo/Gemini'].includes(target)) throw new Error('Unsupported credential target.');
  if (process.platform !== 'win32') return action === 'load' ? Promise.resolve('') : Promise.reject(new Error('Key saving requires Windows Credential Manager.'));
  const script = `Add-Type -TypeDefinition @'\n${source}\n'@\n` + (action === 'save' ? `[HaloCredential]::Save("${target}",[Console]::In.ReadToEnd())` : `[Console]::Out.Write([HaloCredential]::Load("${target}"))`);
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = ''; const timer = setTimeout(() => child.kill(), 10000);
    child.stdout.on('data', x => { output += x; if (output.length > 8192) child.kill(); });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Credential store unavailable.')); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error('Credential store unavailable.')); });
    child.stdin.on('error', () => {}); child.stdin.end(key);
  });
}
export const loadComposioKey = () => credential('Halo/Composio', 'load');
export const saveComposioKey = key => credential('Halo/Composio', 'save', key);
