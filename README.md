# Corte DXF — extensão do Trimble Connect (Web)

Gera um **DXF** a partir do plano de corte (**tesoura**) do Visualizador 3D do
Trimble Connect for Browser. Cada tipo de elemento vira uma camada
(`IFCWALL`, `IFCSLAB`, `IFCCOLUMN`, …) com cor própria.

## Como funciona

Para modelos que excedem a capacidade do navegador, a versão 9 também exporta
a configuração da tesoura para o **[Corte DXF Local](companion/README.md)**.
O auxiliar Windows prepara os IFCs do computador, mantém a geometria em disco
e reutiliza esse resultado nos cortes seguintes. O fluxo original no navegador
continua disponível. Veja os testes comparativos em `experiments/thatopen/` e
`native-bench/`.

1. Lê o plano de corte ativo no visualizador (`viewer.getSectionPlanes`).
2. Tenta reutilizar o **IFC original** fornecido pelo visualizador. Quando não está disponível, baixa o original pela API do Trimble Connect com o token do usuário.
3. Abre cada IFC em um worker separado no navegador ([web-ifc](https://github.com/ThatOpen/engine_web-ifc)) e encerra esse worker após o arquivo, liberando sua memória.
4. Alinha as coordenadas do IFC com as do visualizador comparando caixas envolventes dos mesmos objetos.
5. Calcula a interseção do plano com todos os triângulos e junta os segmentos em polilinhas.
6. Projeta também os contornos dos elementos entre o plano e a profundidade informada.
7. Baixa o `.dxf` (R12, unidades em mm ou m).

Nada sai do navegador do usuário: não existe servidor próprio.

O cache da sessão guarda até 64 MB de IFCs por projeto, modelo e revisão. Arquivos
maiores são processados sem permanecer no cache. **Limpar cache de IFCs** libera
esses bytes. **Cancelar geração** interrompe o download ou o leitor em execução.
Com **Só objetos selecionados**, os modelos sem seleção são dispensados antes
da leitura. IFCs acima de 1 GiB são ignorados, preferencialmente pela consulta de
metadados antes do download. Falhas de um arquivo também permitem continuar com
os demais: o download é identificado como `corte_parcial_...dxf` e o painel lista
os IFCs omitidos. Se nenhum arquivo funcionar, não há DXF para baixar. O botão
**Baixar Log** salva os detalhes completos, incluindo a etapa e, quando disponível,
o elemento IFC que interrompeu a leitura.

### Por que DXF e não DWG?
DWG é um formato fechado da Autodesk e não existe gerador gratuito que rode no navegador.
O DXF abre direto no AutoCAD, BricsCAD, ZWCAD, QCAD etc. Para ter DWG:
- **AutoCAD:** abrir o `.dxf` → *Salvar como* → `.dwg`; ou
- **ODA File Converter** (gratuito): converte uma pasta inteira de DXF para DWG.

### Limitações
- Só modelos **IFC** (RVT, SKP, DWG 3D etc. precisam ser exportados como IFC antes).
- Corta com **um plano** por vez (a tesoura de plano; caixa de corte ainda não).
- A vista em profundidade projeta contornos e arestas, sem remover linhas ocultas entre objetos: elementos sobrepostos podem aparecer juntos no DXF.

### Profundidade do corte

Digite a **Profundidade da vista (m)** no painel, por exemplo `5` para incluir os
elementos até 5 metros a partir da tesoura. O valor é sempre em metros, mesmo quando
o DXF é exportado em milímetros. O padrão é 5 m. Use **Inverter sentido da profundidade**
para obter a vista do outro lado do plano; por padrão a faixa segue o sentido oposto
à normal do plano (em uma planta com normal para cima, olha para baixo).

Elementos que não tocam a tesoura também aparecem se estiverem dentro da faixa.
Objetos que atravessam o limite são recortados à profundidade informada; esse limite
também pode produzir um contorno de recorte. Com profundidade `0`, o app mantém a
exportação anterior, somente das interseções com o plano.

As linhas do plano continuam nas camadas por tipo IFC (`IFCWALL`, `IFCSLAB`, etc.).
Os contornos da vista ficam em camadas separadas com sufixo `_VISTA`, em cinza,
para facilitar ligar/desligar a projeção no CAD. As contagens de corte e vista podem
incluir o mesmo elemento; o total conta cada elemento uma vez por modelo.

## Arquivos

| Arquivo | Para que serve |
|---|---|
| `index.html`, `style.css`, `icon.svg` | Tela da extensão |
| `app.js` | Integração com o Trimble Connect (plano, modelos, token, download) |
| `ifc.js` | Leitura do IFC e corte da geometria |
| `section.js` | Matemática do corte e montagem das polilinhas |
| `depth.js` | Projeção de arestas e contornos na faixa de profundidade |
| `dxf.js` | Gerador do arquivo DXF |
| `manifest.json` | Registro da extensão no Trimble Connect |
| `test/` | IFC de teste e página que roda o corte sem o Trimble |

## Publicar (GitHub Pages)

Já publicado em <https://bfusar2.github.io/app_trimble/> (repositório `bfusar2/app_trimble`,
GitHub Pages servindo a branch `main`). Para atualizar, basta fazer commit e push na `main`;
o site se atualiza em cerca de 1 minuto.

**URL do manifesto:** `https://bfusar2.github.io/app_trimble/manifest.json`

**A cada publicação, aumente o número em `index.html` (`app.js?v=N`).** O GitHub Pages
manda o navegador guardar os arquivos por 10 minutos; o número novo força o download
da versão nova. A versão aparece ao lado do título do painel.

## Testes

Com o servidor local rodando, abra no navegador:
- `test/unitarios.html` — conversão de GUID e medidas em cortes horizontais, verticais e inclinados;
- `test/alinhamento.html` — alinhamento IFC × visualizador (UTM, milímetros, girado, objetos errados);
- `test/teste.html` — corte completo do IFC de exemplo.
- `test/profundidade.html` — geometria da vista, limites de profundidade, sentido e projeção;
- `test/profundidade-ifc.html` — corte e vista com IFC real, seleção e DXF, com comparação visual.

## Alinhamento

O app só exporta se o erro médio do alinhamento ficar abaixo de 10 cm. Se o alinhamento
automático não for possível (objetos não encontrados no visualizador), o corte usa as
coordenadas do próprio IFC e avisa no final para conferir no CAD.

## Registrar no Trimble Connect

1. Abra o projeto em <https://web.connect.trimble.com> (precisa ser **administrador do projeto**).
2. **Configurações → Aplicativos e Recursos → + Adicionar personalizado**.
3. Cole a URL do manifesto e clique em **Adicionar**. Ative o interruptor.
4. Abra um modelo IFC no Visualizador 3D, crie um corte com a **tesoura** e abra o painel **Corte DXF**.
5. Na primeira vez, autorize o acesso quando o Trimble Connect pedir.

## Testar sem o Trimble

Abra `index.html` direto (fora do Trimble Connect): ele entra em **modo local**,
onde você escolhe um IFC do computador e digita o plano (ponto e normal em mm).
Precisa de um servidor local, por exemplo: `python -m http.server 8080` e abrir
<http://localhost:8080>.

## Se algo der errado

- Abra **Log** no rodapé do painel. Ele mostra o alinhamento calculado (escala, deslocamento, erro).
- Se o download do modelo falhar, use **Carregar IFC do computador** no painel: o arquivo é alinhado com o modelo aberto.
- Se o corte sair deslocado, o modelo pode estar girado no Trimble (o alinhamento só corrige escala e deslocamento).
