# Corte DXF Local

Auxiliar Windows para gerar cortes dos IFCs no computador, com geometria
preparada em disco para reutilizar nas próximas vistas. Trabalha junto com a
extensão do Trimble Connect; não precisa receber sua senha ou chave de API.

## Como usar

1. No Trimble, carregue os modelos, posicione a tesoura e informe profundidade,
   unidade, eixos, hachura e eventual seleção.
2. Abra **IFCs grandes: processar no computador** e clique em **Exportar
   configuração do corte**. Salve `corte-trimble.json`.
3. Abra `CorteDXFLocal.exe` na pasta do pacote Windows (extraia o ZIP inteiro).
4. Clique em **Abrir configuração do Trimble** e escolha o JSON.
5. Escolha a pasta do projeto: o auxiliar procura IFCs também nas subpastas.
   Nomes únicos são associados. Para nomes diferentes ou repetidos em pastas
   distintas, dê duplo clique na linha e escolha o IFC correspondente.
6. Use a mesma revisão dos arquivos exibidos no Trimble. A correspondência por
   nome não comprova a revisão; confira antes de gerar.
7. Clique em **Gerar DXF no computador** e escolha onde salvar.

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
