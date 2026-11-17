<#
Monta o pacote PORTÁTIL do Corte DXF Local: uma pasta com um Python próprio, as
bibliotecas e o código do auxiliar. Não tem .exe empacotado (antivírus costumam
removê-lo), não precisa instalar Python e não baixa nada na máquina do usuário.

Uso:  .\build-portatil.ps1            (usa o "python" do PATH como origem)
      .\build-portatil.ps1 -Python C:\Python314\python.exe

Requer: Python x64 instalado a partir do python.org (com tkinter) e acesso ao PyPI
nesta máquina de build, para baixar as bibliotecas fixadas em requirements.txt.
#>
param(
    [string]$Python = "python"
)
$ErrorActionPreference = "Stop"
$companion = $PSScriptRoot
$dist = Join-Path $companion "dist"
$name = "CorteDXFLocal"
$stage = Join-Path $dist "portatil\$name"
$zipPath = Join-Path $dist "CorteDXFLocal-Portatil.zip"

# Programas nativos escrevem avisos no stderr; isso não deve virar erro do PowerShell.
function Invoke-Native([scriptblock]$Command, [string]$Failure) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & $Command | Out-Host } finally { $ErrorActionPreference = $previous }
    if ($LASTEXITCODE -ne 0) { throw $Failure }
}
function Copy-Tree([string]$From, [string[]]$ExcludeDirs = @(), [string[]]$ExcludeFiles = @(), [string]$To) {
    $arguments = @($From, $To, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP")
    if ($ExcludeDirs) { $arguments += @("/XD") + $ExcludeDirs }
    if ($ExcludeFiles) { $arguments += @("/XF") + $ExcludeFiles }
    & robocopy @arguments | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Falha ao copiar $From" }
    $global:LASTEXITCODE = 0
}
function Write-Text([string]$Path, [string]$Text, [bool]$Bom = $false, [bool]$Crlf = $true) {
    if ($Crlf) { $Text = $Text -replace "`r?`n", "`r`n" }
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($Bom)))
}

# 1. Python de origem (instalação do python.org)
$base = (& $Python -c "import sys; print(sys.base_prefix)").Trim()
$tag = (& $Python -c "import sys; print(f'{sys.version_info.major}{sys.version_info.minor}')").Trim()
$version = (& $Python -c "import platform; print(platform.python_version())").Trim()
$arch = (& $Python -c "import struct; print(struct.calcsize('P')*8)").Trim()
if ($arch -ne "64") { throw "Use um Python de 64 bits." }
foreach ($required in @("python.exe", "pythonw.exe", "python$tag.dll", "DLLs", "Lib", "tcl")) {
    if (-not (Test-Path (Join-Path $base $required))) {
        throw "O Python de origem ($base) não tem '$required'. Use a instalação do python.org com tcl/tk."
    }
}
Write-Output "Python de origem: $version ($base)"

# 2. Pasta de montagem limpa
if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -Confirm:$false }
$py = Join-Path $stage "python"
$app = Join-Path $stage "app"
New-Item -ItemType Directory -Force -Path $py, $app | Out-Null

# 3. Núcleo do Python: sem site-packages do usuário, testes, documentação e IDLE
foreach ($file in @("python.exe", "pythonw.exe", "python3.dll", "python$tag.dll", "vcruntime140.dll", "vcruntime140_1.dll", "LICENSE.txt")) {
    $source = Join-Path $base $file
    if (Test-Path $source) { Copy-Item -LiteralPath $source -Destination $py }
}
Copy-Tree -From (Join-Path $base "DLLs") -To (Join-Path $py "DLLs") -ExcludeFiles @("*.lib")
Copy-Tree -From (Join-Path $base "tcl") -To (Join-Path $py "tcl") -ExcludeDirs @("nmake") -ExcludeFiles @("*.lib", "*.sh")
Copy-Tree -From (Join-Path $base "Lib") -To (Join-Path $py "Lib") `
    -ExcludeDirs @("site-packages", "test", "tests", "idlelib", "turtledemo", "ensurepip", "__pycache__")
$site = Join-Path $py "Lib\site-packages"
New-Item -ItemType Directory -Force -Path $site | Out-Null

# 4. Bibliotecas fixadas (versões exatas de requirements.txt, só rodas já compiladas)
Invoke-Native { & $Python -m pip install --disable-pip-version-check --no-compile --only-binary=:all: `
        --target $site -r (Join-Path $companion "requirements.txt") } "Falha ao instalar as bibliotecas."
Remove-Item -LiteralPath (Join-Path $site "bin") -Recurse -Force -ErrorAction SilentlyContinue -Confirm:$false
# Versões exatas instaladas (inclui as dependências, que requirements.txt não fixa).
$frozen = & $Python -m pip freeze --path $site
Write-Text (Join-Path $stage "versoes.txt") ("Python $version`n" + ($frozen -join "`n") + "`n")

# 5. Código do auxiliar
foreach ($file in @("helper.py", "runner.py", "geometry.py", "drawing.py", "faceted.py", "corte-dxf.ico", "requirements.txt")) {
    Copy-Item -LiteralPath (Join-Path $companion $file) -Destination $app
}
Copy-Item -LiteralPath (Join-Path $companion "THIRD_PARTY_NOTICES.md") -Destination $stage
Copy-Tree -From (Join-Path $companion "licenses") -To (Join-Path $stage "licenses")
if (Test-Path (Join-Path $py "LICENSE.txt")) { Move-Item (Join-Path $py "LICENSE.txt") (Join-Path $stage "licenses\PYTHON-LICENSE.txt") -Force }

# O modo isolado de um ._pth não desliga a pasta de bibliotecas do usuário
# (AppData\Roaming\Python): o sitecustomize a retira do caminho de busca.
Write-Text (Join-Path $app "sitecustomize.py") @'
"""Portátil: ignora bibliotecas do Python que o usuário já tenha instalado."""
import site
import sys

_user = site.getusersitepackages() if hasattr(site, "getusersitepackages") else None
if _user:
    sys.path[:] = [p for p in sys.path if p.rstrip("\\/").lower() != _user.rstrip("\\/").lower()]
'@

# 6. Modo isolado: este Python só enxerga a própria pasta (ignora PATH, registro e
#    o Python/bibliotecas que o colega já tenha instalado).
Write-Text (Join-Path $py "python$tag._pth") @"
Lib
DLLs
Lib\site-packages
..\app
import site
"@

# 7. Atalhos de uso (sem PowerShell com Bypass e sem .exe)
Write-Text (Join-Path $stage "Abrir Corte DXF Local.cmd") @'
@echo off
setlocal
set "BASE=%~dp0"
if not exist "%BASE%python\pythonw.exe" (
  echo Pasta incompleta: python\pythonw.exe nao foi encontrado.
  echo Extraia o ZIP inteiro e tente de novo. Se o antivirus removeu arquivos, avise a TI.
  pause
  exit /b 1
)
start "" "%BASE%python\pythonw.exe" "%BASE%app\helper.py"
'@

Write-Text (Join-Path $stage "Criar atalho na Area de Trabalho.cmd") @'
@echo off
setlocal
set "CORTE_BASE=%~dp0"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "$b=$env:CORTE_BASE.TrimEnd([char]92); $d=$env:CORTE_ATALHO_DESTINO; if(-not $d){$d=[Environment]::GetFolderPath('Desktop')}; $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'Corte DXF Local.lnk')); $s.TargetPath=$b+[char]92+'python'+[char]92+'pythonw.exe'; $s.Arguments=[char]34+$b+[char]92+'app'+[char]92+'helper.py'+[char]34; $s.WorkingDirectory=$b+[char]92+'app'; $s.IconLocation=$b+[char]92+'app'+[char]92+'corte-dxf.ico'; $s.Description='Corte DXF Local'; $s.Save()"
if errorlevel 1 (
  echo Nao foi possivel criar o atalho.
  echo Alternativa: botao direito em "Abrir Corte DXF Local.cmd" ^> Enviar para ^> Area de trabalho.
  pause
  exit /b 1
)
echo Atalho "Corte DXF Local" criado na Area de Trabalho.
pause
'@

Write-Text (Join-Path $stage "Verificar instalacao.cmd") @'
@echo off
setlocal
set "BASE=%~dp0"
echo Verificando o Python e as bibliotecas deste pacote...
"%BASE%python\python.exe" "%BASE%app\helper.py" --smoke
if errorlevel 1 (
  echo.
  echo FALHA: alguma biblioteca nao carregou. Envie esta tela para quem mantem o auxiliar.
) else (
  echo.
  echo Tudo certo: as bibliotecas carregaram.
)
pause
'@

Write-Text (Join-Path $stage "LEIA-ME.txt") @"
CORTE DXF LOCAL - PACOTE PORTATIL (versao do Python: $version)

Gera cortes DXF dos IFCs no computador, a partir da configuracao exportada no
Trimble Connect. Nao precisa instalar nada, nem ter Python, nem internet.

COMO COMECAR
1. Se o ZIP veio da internet, e-mail ou Teams: clique com o botao direito no ZIP,
   escolha Propriedades, marque "Desbloquear" e clique em OK. Faca isso ANTES de extrair.
2. Extraia o ZIP inteiro numa pasta curta (por exemplo C:\CorteDXF ou a Area de
   Trabalho). Nao abra os arquivos de dentro do ZIP.
3. Abra "Abrir Corte DXF Local.cmd".
4. Opcional: abra "Criar atalho na Area de Trabalho.cmd" para ter o atalho com o icone.

COMO USAR
1. No Trimble, posicione a tesoura e clique em "Exportar configuracao do corte".
2. O corte aparece sozinho no auxiliar. Clique em "Gerar DXF".
3. Se o auxiliar nao souber onde esta algum IFC, ele pergunta: escolha o arquivo no
   computador (da mesma revisao que esta no Trimble). Ele lembra para as proximas vezes.
4. O DXF e salvo na pasta Downloads. "Mostrar DXF na pasta" abre o Explorer nele.

SE NAO ABRIR
- Abra "Verificar instalacao.cmd". Se aparecer FALHA, algum arquivo foi removido
  (normalmente pelo antivirus). Avise a TI e extraia o ZIP de novo depois da liberacao.
- A pasta nao pode estar dentro do ZIP nem em um caminho muito longo.

O auxiliar guarda suas escolhas e a geometria preparada em
%USERPROFILE%\.corte-dxf  (pode ser apagada; fica fora desta pasta).
"@ -Bom $true

# 8. Pré-compila (arranque mais rápido e menos escrita no disco do usuário)
$null = & "$py\python.exe" -m compileall -q -j 0 --invalidation-mode checked-hash "$py\Lib" $app 2>&1
$global:LASTEXITCODE = 0

# 9. ZIP
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force -Confirm:$false }
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zipPath, [IO.Compression.CompressionLevel]::Optimal, $true)
$zip = Get-Item $zipPath
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
"{0}  {1:N1} MB  SHA256 {2}" -f $zip.FullName, ($zip.Length / 1MB), $hash
$stage
