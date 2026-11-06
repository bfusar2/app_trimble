Gera cortes DXF dos IFCs no computador e reaproveita a geometria preparada nos próximos cortes do Trimble Connect.

**Windows x64:** extraia o ZIP inteiro e abra `CorteDXFLocal.exe`. O pacote inclui as bibliotecas; não exige instalar Python ou Bonsai.

## Novidades da 1.2 — o auxiliar pergunta pelo arquivo

- Ao clicar em **Gerar DXF**, o auxiliar pergunta onde está cada IFC que ainda não foi localizado ("Onde está o IFC …?"). Não é mais preciso escolher a pasta antes nem dar duplo clique na lista.
- Modelos sem arquivo aparecem em vermelho como "Não localizado", com o botão **Localizar IFC…** e o contador "Falta localizar".
- A pasta do primeiro IFC escolhido fica lembrada e os outros modelos com o mesmo nome de arquivo são encontrados nela.
- A lista mostra o nome do arquivo e a pasta, e **Gerar DXF** ficou em destaque.

Da 1.1: abre sozinho a configuração mais recente exportada pelo painel (pasta Downloads), lembra as escolhas por revisão do modelo e salva o DXF ao lado da configuração.

## Uso

1. Abra `CorteDXFLocal.exe`.
2. No Trimble, clique em **Exportar configuração do corte**. O corte aparece sozinho no auxiliar.
3. Clique em **Gerar DXF**. Se o auxiliar não souber onde está algum IFC, ele pergunta: escolha o arquivo da mesma revisão do Trimble.

O motor de geometria e de desenho é o mesmo da 1.0. Validação com IFC real de 1,11 GB: 89 conjuntos e todas as 3.532.354 faces referenciadas, 6.706.783 triângulos. Preparo do zero: 5 min 49 s / pico de 5,53 GiB. Corte com profundidade de 5 m usando cache em 28,55 s: 231.323 entidades, 24 HATCH, auditoria DXF sem erros. Medições neste computador; o desempenho varia conforme modelo e máquina.

O auxiliar exige alinhamento verificado por referências. Modelos com um único objeto precisam de conferência explícita das coordenadas originais. Linhas ocultas entre objetos permanecem na projeção.

O executável não tem assinatura digital: filtros corporativos podem bloquear o download. Nesse caso, peça à TI a liberação deste arquivo.

Instruções: https://bfusar2.github.io/app_trimble/companion/

Código e testes: https://github.com/bfusar2/app_trimble/tree/main/companion

Nenhum modelo de cliente faz parte desta distribuição.
