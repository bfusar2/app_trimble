Gera cortes DXF dos IFCs no computador e reaproveita a geometria preparada nos próximos cortes do Trimble Connect.

**Windows x64:** extraia o ZIP inteiro e abra `CorteDXFLocal.exe`. O pacote inclui as bibliotecas; não exige instalar Python ou Bonsai.

## Novidades da 1.1 — menos passos

- Abre sozinho a configuração mais recente exportada pelo painel (pasta Downloads) e carrega cada nova exportação enquanto estiver aberto.
- Lembra a pasta dos IFCs e os arquivos escolhidos por duplo clique. Um arquivo só é reaproveitado para a mesma revisão do modelo; uma revisão nova no Trimble pede o IFC atualizado.
- Salva o DXF ao lado da configuração (`corte_AAAAMMDD_HHMM.dxf`, sem sobrescrever) e oferece **Mostrar DXF na pasta**.
- A confirmação de coordenadas só aparece para modelos com menos de três referências e nomeia esses modelos.

## Uso

No painel do Trimble, clique em **Exportar configuração do corte** (no aviso de IFC pesado ou em **IFCs grandes: processar no computador**). Abra o auxiliar; na primeira vez escolha a pasta do projeto (IFCs com nomes únicos são encontrados também nas subpastas). Clique em **Gerar DXF**. Use a mesma revisão do Trimble.

O motor de geometria e de desenho é o mesmo da 1.0. Validação com IFC real de 1,11 GB: 89 conjuntos e todas as 3.532.354 faces referenciadas, 6.706.783 triângulos. Preparo do zero: 5 min 49 s / pico de 5,53 GiB. Corte com profundidade de 5 m usando cache em 28,55 s: 231.323 entidades, 24 HATCH, auditoria DXF sem erros. Medições neste computador; o desempenho varia conforme modelo e máquina.

O auxiliar exige alinhamento verificado por referências. Modelos com um único objeto precisam de conferência explícita das coordenadas originais. Linhas ocultas entre objetos permanecem na projeção.

O executável não tem assinatura digital: filtros corporativos podem bloquear o download. Nesse caso, peça à TI a liberação deste arquivo.

Instruções: https://bfusar2.github.io/app_trimble/companion/

Código e testes: https://github.com/bfusar2/app_trimble/tree/main/companion

Nenhum modelo de cliente faz parte desta distribuição.
