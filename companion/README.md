# Corte DXF Local

Auxiliar Windows para gerar cortes dos IFCs no computador, com geometria
preparada em disco para reutilizar nas próximas vistas. Trabalha junto com a
extensão do Trimble Connect; não precisa receber sua senha ou chave de API.

## Como usar

1. Abra `CorteDXFLocal.exe`.
2. No Trimble, posicione a tesoura e clique em **Exportar configuração do
   corte** (no aviso de IFC pesado ou em **IFCs grandes: processar no
   computador**). O corte aparece sozinho no auxiliar: ele lê o
   `corte-trimble.json` mais recente da pasta Downloads.
3. Clique em **Gerar DXF**. Se algum IFC não estiver localizado (aparece em
   vermelho como "Não localizado"), o auxiliar pergunta onde ele está. Escolha o
   arquivo; se cancelar, ele pergunta se deve gerar sem aquele modelo.
4. O DXF é salvo ao lado do JSON (`corte_AAAAMMDD_HHMM.dxf`, sem sobrescrever).
   **Mostrar DXF na pasta** abre o Explorer nele.

O auxiliar lembra o que você escolheu, em `%USERPROFILE%\.corte-dxf\settings.json`:

- A pasta do primeiro IFC escolhido vira a pasta dos IFCs; nos próximos cortes,
  os modelos com o mesmo nome de arquivo são encontrados nela (também em
  subpastas). **Procurar todos numa pasta…** troca essa pasta.
- Um arquivo escolhido para um modelo é reaproveitado só para a mesma revisão.
  Quando o Trimble tem uma revisão nova, o modelo volta a "Não localizado" e o
  auxiliar pergunta pelo arquivo atualizado.
- **Localizar IFC…** troca o arquivo do modelo selecionado na lista.

Escolha sempre a mesma revisão exibida no Trimble. Encontrar um arquivo pelo
nome não comprova a revisão; uma pasta sincronizada pelo Trimble Connect Desktop
acompanha a versão atual.

A caixa **Confirmo que usam as mesmas coordenadas da tesoura** só aparece para
modelos com menos de três referências e começa desmarcada a cada corte (veja
**Alinhamento**).

Pode usar uma pasta sincronizada pelo Trimble Connect Desktop como origem dos
IFCs. O auxiliar não precisa baixar os arquivos novamente a cada corte. Na
primeira leitura, calcula a geometria e guarda o resultado em
`%USERPROFILE%\.corte-dxf\cache`. Nos próximos cortes, verifica o conteúdo do
IFC por SHA-256 e reutiliza a geometria se o arquivo não mudou.

## Alinhamento

O JSON inclui referências de objetos do visualizador, nunca o IFC ou tokens.
O auxiliar usa essas referências para verificar posição, rotação e unidade e
projetar todos os modelos no mesmo referencial de desenho.

Se houver menos de três referências coerentes, a geração desse modelo é
recusada. A R3 usada no teste é um exemplo: possui praticamente todo o modelo
em um único objeto. A opção **Confirmo que os IFCs usam as mesmas coordenadas
da tesoura** permite usar as coordenadas originais após conferência pelo
usuário. Ela se aplica a todos os arquivos do lote; não a use se modelos foram
movidos ou girados no visualizador.

## Processamento e resultados

- IFCs com faces explícitas compatíveis são lidos por partes, preservando
  contornos internos. O relatório registra faces de origem e triângulos.
- Outros IFCs usam o motor geométrico nativo IfcOpenShell. Falhas registradas
  pelo leitor impedem aceitar um resultado incompleto.
- Arquivos são processados em sequência. Uma falha permite gerar o DXF dos
  demais, identificado como `_parcial`, com omissões no relatório JSON.
- A saída inclui profundidade, eixos retos compatíveis e hachura CAD nos
  contornos fechados. Linhas ocultas entre objetos continuam presentes.
- O DXF local é R2010 e contém polilinhas e entidades HATCH; o DXF do fluxo
  original no navegador continua R12 com hachuras desenhadas em linhas.
- Geometria degenerada sem área é contada separadamente no relatório.
- Contornos inválidos de faces planas podem ser corrigidos por operações
  geométricas do Shapely. O relatório informa quantas faces foram corrigidas,
  exemplos dos seus IDs e a maior diferença de planaridade observada. O IFC
  original é preservado; confira esses avisos antes de usar o desenho.
- Nenhum motor garante aceitar qualquer IFC. Geometria inválida ou uma
  representação ainda não suportada deve ser reportada; não tratada como
  desenho completo.

O cache ocupa espaço em disco e pode ser removido com o auxiliar fechado.
Cancelar encerra o processo de cálculo. Uma preparação interrompida pode deixar
uma pasta `.preparing-*` sem manifesto; ela não será usada como cache válido.

## Pacote portátil (sem .exe, sem instalar, sem internet)

Alternativa ao `CorteDXFLocal.exe` para máquinas onde o antivírus remove o
executável ou o download do GitHub é bloqueado. É uma pasta com um Python
próprio (o do python.org, assinado pela Python Software Foundation), as
bibliotecas e o código do auxiliar. Não há executável empacotado.

Para o usuário: extrair o ZIP inteiro, abrir **Abrir Corte DXF Local.cmd** e,
se quiser, **Criar atalho na Area de Trabalho.cmd**. O `LEIA-ME.txt` do pacote
explica tudo, inclusive desbloquear o ZIP baixado (Propriedades → Desbloquear)
e o **Verificar instalacao.cmd**, que confere se as bibliotecas carregam.

O pacote roda em modo isolado (`python314._pth`): enxerga só a própria pasta,
ignora o PATH, o registro e qualquer Python ou biblioteca já instalados na
máquina. As escolhas e o cache continuam em `%USERPROFILE%\.corte-dxf`.
`versoes.txt` dentro do pacote registra as versões exatas, inclusive das
dependências.

Para gerar: `.\build-portatil.ps1` (usa o `python` do PATH; precisa ser Python
x64 do python.org com tcl/tk e acesso ao PyPI nesta máquina de build). Resultado
em `dist\CorteDXFLocal-Portatil.zip`, cerca de 96 MB. Como o ZIP não depende do
GitHub, pode ser distribuído por pasta de rede, Teams ou Trimble Connect. Os
arquivos Python do próprio Windows e da biblioteca padrão são os originais; os
módulos compilados de terceiros (IfcOpenShell, NumPy, Shapely) não têm
assinatura digital, e um antivírus pode reagir a eles. Teste na máquina de
destino antes de distribuir para toda a equipe.

## Antivírus corporativo

O `CorteDXFLocal.exe` não tem assinatura digital. Antivírus corporativos (por
exemplo, SentinelOne) podem apagá-lo ao extrair o ZIP ou depois, inclusive
cópias já usadas: a pasta fica com `_internal`, `licenses` e `source`, mas sem o
`.exe`. Não é possível abrir o auxiliar assim. Peça à TI que libere o arquivo
(restaurar da quarentena e criar exceção), informando a página de download e o
SHA-256 do executável da versão em uso. Cada versão nova tem outro SHA-256; uma
exceção pelo certificado só é possível depois que o executável for assinado.

## Executar a partir do código

Requer Python x64 compatível com as versões de `requirements.txt` (testado com
Python 3.14). Instale as dependências em um ambiente virtual e execute:

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python helper.py
```

Para automação sem interface:

```powershell
python runner.py corte-trimble.json --folder C:\Modelos --output C:\Desenhos\corte.dxf
```

`--map` aceita um JSON `modelId -> caminho local`. `--ifc-coordinates` exige a
mesma conferência explícita de coordenadas descrita acima.

Para gerar o pacote Windows: `build.ps1 -Zip`. O pacote inclui bibliotecas de
terceiros; preserve as licenças e avisos distribuídos com ele.
