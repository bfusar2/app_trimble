# Validação do fluxo Trimble → Corte DXF Local — 2026-11-05

Fonte real IFC2X3 de 1.113.119.703 bytes; cerca de 17,45 milhões de registros.
Modelo preservado e privado, fora do Git. Windows x64, Python 3.14,
IfcOpenShell 0.9.0.post1, NumPy 2.5.2, Shapely 2.2.0, ezdxf 1.4.5.

| Caminho testado | Resultado |
|---|---|
| That Open Fragments/Components 3.6.0, web-ifc 0.0.78, leitura por callback | IFC pequeno convertido e DXF gerado; IFC pesado falhou em 14,06 s / 3,38 GiB |
| IfcOpenShell / OpenCASCADE | Interrompido ao atingir o orçamento de 8 GiB |
| IfcOpenShell / cgal-simple | Retornou 80.952 triângulos; cobertura insuficiente, rejeitado como prova de conversão |
| IfcOpenShell / híbrido | Interrompido após 301 s / 17,29 GiB, sem resultado aprovado |
| Auxiliar: leitura direta das faces + correção controlada + cache | Preparo completo aprovado em 349,279 s / pico 5,533 GiB |
| Executável Windows: geração com cache, profundidade 5 m | 28,55 s / pico amostrado 1,320 GiB; DXF aprovado |

## Cobertura e integridade

Auditorias independentes confirmaram:

- 89 conjuntos de faces, com **3.532.354/3.532.354 faces referenciadas**;
- 6.251.871 vértices e 6.706.783 triângulos; coordenadas finitas, índices e caixas válidos;
- 32 contornos corrigidos por operações planares, com IDs e motivos no relatório;
- desvio máximo de planaridade 2,9594e-7 m (0,296 micrômetro);
- zero faces inteiramente degeneradas; 7.268 subdivisões triangulares de área nula são excluídas da análise de arestas;
- 178 arquivos de geometria iguais por SHA256 entre a execução com checkpoint e a preparação independente do zero;
- reutilização do cache em 0,547 s, incluindo hash do IFC. Esse tempo **não inclui** gerar o desenho.

Há 80.952 registros IfcFace não referenciados pelos conjuntos do corpo, portanto
contar todos os registros STEP não representa a geometria usada no modelo.

DXF real do executável: 50.145.492 bytes, 231.299 LWPOLYLINE e 24 HATCH;
73 polilinhas na camada de corte e 231.226 na projeção em profundidade.
Arquivo reaberto com ezdxf: zero erros de auditoria, nenhuma omissão no relatório.

## Fluxo aprovado e limites

A extensão exporta plano, opções, seleção e referências por objeto. O auxiliar
lê os IFCs locais (inclusive de uma pasta sincronizada), prepara geometria em
disco por conteúdo/revisão do motor e gera desenhos sobre esse cache.

O corte pesado de validação foi feito no meio da caixa do IFC, em suas
coordenadas originais. Não comprova o alinhamento da tesoura de uma sessão
autenticada do projeto. Como o IFC contém um único objeto, esse alinhamento não
pode ser inferido por três referências: o auxiliar exige conferência explícita.
Testes com modelos sintéticos verificam o alinhamento comum entre IFCs
transladados/girados e referências em metros/milímetros.

O auxiliar mantém linhas ocultas entre objetos. O IFC pesado testado passou;
isso não garante suporte a toda geometria inválida ou representação IFC.
Erros de outros modelos são reportados e permitem um DXF parcial dos demais.

Testes incluem fluxo de lote/cancelamento/exportação no navegador, GUIDs,
profundidade, planos inclinados, reversão, seleção, unidades, eixos, hachuras
com furos/sobreposições, cache e revisão, faces explícitas e reparos. As suítes
e os scripts de reprodução estão em `test/`, `native-bench/` e
`experiments/thatopen/`.
