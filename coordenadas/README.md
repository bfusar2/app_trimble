# Coordenadas CSV — extensão do Trimble Connect (Web)

Lista os pontos marcados no Visualizador 3D do Trimble Connect for Browser, numera
como **P1, P2, P3…**, cria **pontos médios** e **interseções de linhas**, converte coordenadas
locais em **globais (UTM)** e exporta tudo em **CSV**. O mesmo CSV (ou um de topografia) pode
ser importado de volta para marcar as coordenadas no modelo.

## Como usar

1. Abra o modelo no Visualizador 3D e o painel **Coordenadas CSV**.
2. Clique em **Marcar pontos no modelo** e clique nos pontos (vértices, arestas, faces).
   Os pontos feitos em **Medir → Ponto** também entram na lista, na ordem em que foram criados.
3. **Ponto médio:** marque 2 pontos na lista (ou nenhum, para usar os 2 últimos) e clique no botão.
   O ponto médio também é marcado no modelo (laranja), com a descrição “Médio de P1 e P2”.
   **Interseção de 2 linhas:** marque 4 pontos *na ordem*: os 2 primeiros formam a 1ª linha e os
   2 seguintes a 2ª (ou nenhum, para usar os 4 últimos). O botão mostra as linhas, ex.:
   `Interseção P1–P3 × P2–P4` (diagonais de um pilar). O ponto é marcado no modelo (roxo).
   - em 3D (padrão), se as linhas não se cruzam exatamente, o ponto fica no meio da menor
     distância entre elas e o app informa essa distância;
   - com **Interseção em planta**, as linhas se cruzam em X e Y e o Z é a média das duas linhas
     naquele ponto (o app informa a diferença de Z);
   - linhas paralelas dão aviso; o cruzamento pode ficar no prolongamento das linhas.
4. Edite nomes e descrições direto na lista, se quiser. **Renumerar** fecha as lacunas
   (P1, P2, P3…) sem mexer em nomes próprios, como os importados.
5. **Exportar CSV.**

O ✕ de cada linha e **Apagar todos** apagam as marcações também do modelo.

### CSV

```
Ponto;X (m);Y (m);Z (m);Descrição
P1;734810,410;7527201,640;445,950;
P2;734814,410;7527203,640;445,950;
P3;734812,410;7527202,640;445,950;Médio de P1 e P2
```

- **Excel pt-BR** (padrão): `;` entre colunas e vírgula decimal, com BOM para os acentos abrirem certo no Excel.
- **CAD / topografia**: `,` entre colunas e ponto decimal, sem BOM (Civil 3D, estação total etc.).
- Coordenadas em metros com 3 casas (milímetro), exatamente como o Trimble mostra em Medir → Ponto.

### Importar

**Importar CSV de pontos** marca cada linha no modelo (verde) e acrescenta à lista. Aceita:

- o próprio CSV exportado (qualquer um dos dois formatos);
- cabeçalhos em qualquer ordem: `Ponto/Nome`, `X/E/Este`, `Y/N/Norte`, `Z/Cota/Elevação`, `Descrição/Código`
  (um arquivo PNEZD com cabeçalho `Ponto,N,E,Cota,Descricao` funciona);
- sem cabeçalho: `Ponto;X;Y;Z;Descrição` ou só `X;Y;Z`;
- separadores `;`, `,`, tabulação ou espaços; arquivos UTF-8 ou ANSI (Excel).

Linhas sem X, Y e Z numéricos são ignoradas e listadas no Log. Para uma coordenada só,
use **Marcar uma coordenada digitada**.

### Coordenadas globais (modelo em coordenadas locais)

Quando os pontos parecem estar em coordenadas locais (perto da origem, fora da faixa UTM), a
seção **5. Coordenadas globais** abre sozinha e pede como converter. Dois métodos:

- **Pontos de controle (2 ou mais):** escolha pontos da lista cuja coordenada global você conhece
  (marcos, cruzamentos de eixos) e digite E, N e Cota. O app ajusta rotação e deslocamento
  (Helmert 2D por mínimos quadrados) e mostra o resíduo de cada ponto; acima de 5 cm fica em vermelho.
  **Calcular fator de escala** inclui a escala no ajuste (ex.: fator UTM); sem marcar, a escala é 1.
  Sem cota nos pontos de controle, Cota = Z do modelo.
- **Ponto base e rotação:** a coordenada de um mesmo ponto nos dois sistemas, a rotação
  (graus, anti-horário do eixo X local até o E; ângulo horário vira negativo) e a escala.

Com a conversão ativa:

- cada ponto da lista mostra também E, N e Cota;
- o CSV pode sair **do modelo e globais** (padrão: `Ponto;X;Y;Z;E;N;Cota;Descrição`), **só globais**
  ou **só do modelo**;
- a importação e a coordenada digitada aceitam **coordenadas globais**: um levantamento em UTM é
  convertido e marcado no lugar certo do modelo.

A configuração fica guardada neste navegador, por projeto. O app só lê o nome do sistema de
coordenadas do projeto no Trimble; a relação local ↔ global precisa ser informada aqui.

### No DXF do Corte DXF

O [Corte DXF](../README.md#pontos-marcados) desenha os mesmos pontos no corte (camadas `PONTOS`
e `PONTOS_COORD`), com os nomes e descrições daqui, desde que os dois painéis sejam abertos na
mesma aba do navegador. Sem isso, o Corte DXF numera P1, P2… na ordem de criação.

### Nomes no modelo

Com **Mostrar os nomes no modelo**, cada ponto ganha uma marcação de texto com o nome (P1, P2…).
Desmarque para apagar esses textos. As marcações de ponto continuam.

## Como funciona

Os pontos são as **marcações de ponto** do próprio Trimble Connect
(`markup.getSinglePointMarkups`, coordenadas em mm). O app lê essas marcações quando o Trimble
avisa de uma mudança (`viewer.onMarkupChanged`) e a cada 3 segundos, converte para metros
e guarda nome e descrição de cada uma. Pontos médios e importados são criados com
`markup.addSinglePointMarkups`. Nomes e descrições ficam guardados na sessão do navegador
para reabrir o painel sem perder a numeração.

Nada sai do navegador do usuário: não existe servidor próprio.

## Arquivos

| Arquivo | Para que serve |
|---|---|
| `index.html`, `app.css`, `icon.svg` | Tela da extensão (usa também o `../style.css`) |
| `app.js` | Integração com o Trimble Connect, lista, ponto médio, exportar e importar |
| `points.js` | CSV (gerar e ler), números, nomes e ponto médio, sem dependência do Trimble |
| `marked.js` | Leitura dos pontos com os nomes da sessão e desenho no DXF (usado também pelo Corte DXF) |
| `geo.js` | Conversão local ↔ global: pontos de controle (Helmert 2D) ou ponto base + rotação |
| `mock-viewer.js` | Visualizador simulado para o modo local |
| `manifest.json` | Registro da extensão no Trimble Connect |
| `../test/coordenadas.html` | Testes do CSV e dos cálculos |

## Registrar no Trimble Connect

**URL do manifesto:** `https://bfusar2.github.io/app_trimble/coordenadas/manifest.json`

1. Abra o projeto em <https://web.connect.trimble.com> (precisa ser **administrador do projeto**).
2. **Configurações → Aplicativos e Recursos → + Adicionar personalizado**.
3. Cole a URL do manifesto e clique em **Adicionar**. Ative o interruptor.
4. Abra o modelo no Visualizador 3D e o painel **Coordenadas CSV**.

**A cada publicação, aumente o número em `index.html` (`app.js?v=N`).**

## Testar sem o Trimble

Com o servidor local (`python -m http.server 8080` na raiz do repositório):

- <http://localhost:8080/coordenadas/> abre o app em **modo local**, com visualizador simulado:
  ative a marcação e use **Simular clique**;
- <http://localhost:8080/test/coordenadas.html> roda os testes.

## Conferir na primeira vez

Marque um ponto com **Medir → Ponto** e compare a linha da lista com o rótulo do Trimble
(ex.: `X 734810.41 m | Y 7527201.64 m | Z 445.95 m`). O **Log** mostra o valor bruto em mm
de cada ponto lido.
