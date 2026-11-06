Gera cortes DXF dos IFCs no computador e reaproveita a geometria preparada nos próximos cortes do Trimble Connect.

**Windows x64:** extraia o ZIP inteiro e abra `CorteDXFLocal.exe`. O pacote inclui as bibliotecas; não exige instalar Python ou Bonsai.

No painel do Trimble, abra **IFCs grandes: processar no computador**, exporte a configuração da tesoura e abra no auxiliar. Escolha a pasta do projeto: IFCs com nomes únicos são encontrados também nas subpastas. Use a mesma revisão do Trimble.

Validação com IFC real de 1,11 GB: 89 conjuntos e todas as 3.532.354 faces referenciadas, 6.706.783 triângulos. Preparo do zero: 5 min 49 s / pico de 5,53 GiB. O executável gerou o corte com profundidade de 5 m usando cache em 28,55 s: 231.323 entidades, 24 HATCH, auditoria DXF sem erros e nenhum IFC omitido. Medições neste computador; o desempenho varia conforme modelo e máquina.

Foram corrigidos 32 contornos inválidos do IFC, identificados no relatório. O original é preservado. Linhas ocultas entre objetos permanecem na projeção.

O auxiliar exige alinhamento verificado por referências. Modelos com um único objeto, como o usado no teste, precisam de conferência explícita das coordenadas originais antes de dispensar o alinhamento automático. O teste pesado usou um corte de validação nessas coordenadas; a tesoura do projeto deve ser conferida ao usar o auxiliar.

Instruções: https://bfusar2.github.io/app_trimble/companion/

Código e testes: https://github.com/bfusar2/app_trimble/tree/main/companion

O modelo privado não faz parte desta distribuição.
