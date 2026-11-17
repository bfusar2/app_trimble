Pacote **portátil** do Corte DXF Local para Windows x64: uma pasta com o Python próprio, as bibliotecas e o código do auxiliar. **Não tem `.exe` empacotado**, não precisa instalar nada, não precisa ter Python e não baixa nada na máquina do usuário.

Serve para máquinas onde o antivírus remove o `CorteDXFLocal.exe` (executável sem assinatura digital) ou onde o download do GitHub é bloqueado: o ZIP pode ser distribuído por pasta de rede, Teams ou Trimble Connect.

## Como usar

1. Se o ZIP veio da internet, e-mail ou Teams: botão direito no ZIP → **Propriedades** → marque **Desbloquear** → OK. Faça isso antes de extrair.
2. Extraia o ZIP inteiro numa pasta curta (por exemplo `C:\CorteDXF`). Não abra os arquivos de dentro do ZIP.
3. Abra **Abrir Corte DXF Local.cmd**. Opcionalmente, **Criar atalho na Area de Trabalho.cmd** cria o atalho com o ícone.
4. No Trimble, posicione a tesoura e clique em **Exportar configuração do corte**. O corte aparece sozinho no auxiliar; clique em **Gerar DXF**. Se faltar algum IFC, o auxiliar pergunta onde está o arquivo e lembra para as próximas vezes.

Se não abrir, **Verificar instalacao.cmd** mostra se as bibliotecas carregaram. O `LEIA-ME.txt` do pacote explica o restante.

## O que há dentro

- Python 3.14.7 do python.org, em modo isolado: enxerga só a própria pasta e ignora o PATH, o registro e qualquer Python ou biblioteca já instalados na máquina.
- IfcOpenShell 0.9.0.post1, NumPy 2.5.2, Shapely 2.2.0, ezdxf 1.4.5 e dependências (`versoes.txt` lista as versões exatas).
- O mesmo auxiliar da versão 1.2, com o ícone novo na janela e na barra de tarefas.
- Licenças e avisos de terceiros em `licenses\` e `THIRD_PARTY_NOTICES.md`.

## Antes de distribuir

O Python e a biblioteca padrão são os originais do python.org (assinados pela Python Software Foundation). Os módulos compilados de terceiros (IfcOpenShell, NumPy, Shapely) não têm assinatura digital, e um antivírus corporativo pode reagir a eles. **Teste em uma máquina da equipe antes de distribuir para todos.** Se algum arquivo for removido, peça à TI para liberar a pasta do pacote.

O pacote foi verificado extraindo o ZIP numa pasta com espaço no nome, sem Python no PATH: bibliotecas, janela, fluxo completo de geração do DXF e os três atalhos.

Instruções gerais: https://bfusar2.github.io/app_trimble/companion/

Para gerar o pacote: `companion/build-portatil.ps1` (código em https://github.com/bfusar2/app_trimble/tree/main/companion).

Nenhum modelo de cliente faz parte desta distribuição.
