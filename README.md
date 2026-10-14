# query-pane

Mod do Claude Code que abre um painel lateral com as queries do AWS Athena que o Claude rodou na sessão: quanto cada uma escaneou, quanto custou, se leu tabela particionada sem filtro, se a sua sessão AWS ainda vale, e as primeiras linhas do resultado. Funciona no terminal e na aba Code do app desktop.

## O que mostra

- **Resumo da sessão**: total escaneado, número de queries e custo aproximado, com uma barra em que cada query é um segmento proporcional ao que escaneou. Passe o mouse num segmento para ver horário, tamanho e SQL.
- **Status da AWS**: `aws ok · conta …` em verde, ou `aws expirada · rode aws login` em vermelho. Checa a cada 60 segundos e sempre que uma chamada à AWS volta expirada.
- **Um card por query**: horário, status (ok, rodando, falhou), medidor de tamanho, SQL em uma linha, tempo, linhas e ID. A cor do medidor indica o custo: verde abaixo de 1 GiB, amarelo de 1 a 10 GiB, vermelho acima.
- **Alerta de query cara**: toast e selo vermelho quando uma query escaneia acima do limite (10 GiB por padrão).
- **Aviso de partição**: lê no Glue as colunas de partição de cada tabela da query (e, numa view, as da tabela por baixo que ela repassa). Se a query não filtra nenhuma, o card mostra `possível leitura sem partição` e sai um toast. A checagem lê o texto do SQL, por isso diz "possível".
- **Prévia do resultado**: botão `ver prévia` mostra as 5 primeiras linhas, direto do Athena, sem custo de scan.
- **Atalhos**: `abrir csv`, `mostrar no finder`, `copiar sql`, `copiar id`, `copiar caminho do csv`. O botão `atualizar` (`r`) relê tudo; queries rodando já se atualizam sozinhas a cada 5 segundos.

O painel abre sozinho na primeira query da sessão. Para reabrir, digite `/queries`.

## De onde vêm as queries

Qualquer ferramenta cuja saída traga um `QueryExecutionId` entra no painel:

- um script que imprima `QueryExecutionId: <id>` (como a skill `athena-query`), e opcionalmente `CSV_PATH: <caminho>` e `ROWS: <n>` para o CSV local e a contagem de linhas;
- `aws athena start-query-execution` e `get-query-execution` no terminal;
- o MCP do Athena (`awslabs.aws-dataprocessing-mcp-server`).

## Requisitos

- AWS CLI v2 no `PATH`, com uma credencial que possa chamar `athena:GetQueryExecution`, `athena:GetQueryResults`, `glue:GetTable` e `sts:GetCallerIdentity`. O mod usa o profile e a região padrão do seu ambiente.
- `open` do macOS para os botões de abrir CSV. Em outros sistemas esses botões mostram um aviso de erro.

## Instalar

Rode no terminal:

```bash
claude plugin install query-pane --marketplace iagodemacedo/query-pane
```

Instala no escopo de usuário, então o painel vale para toda sessão nova, no terminal e na aba Code do app desktop. Abra uma sessão nova depois de instalar.

Dentro de uma sessão no terminal também dá para digitar `/plugin install query-pane --marketplace iagodemacedo/query-pane`, responder `y` para adicionar o marketplace e apertar Enter para manter o escopo de usuário. O `/plugin` não existe na aba Code do app desktop: instale uma vez pelo terminal e o desktop passa a usar.

## Configurar

O limite do alerta de query cara fica no campo `alertGiB` (padrão 10), no menu de configuração do plugin.

## Custo mostrado

A estimativa usa o preço on-demand do Athena: US$ 5 por TB escaneado, mínimo de 10 MB por query. Se a sua conta tem outro preço ou usa capacidade provisionada, o valor não se aplica.

## Privacidade

A prévia mostra dados reais do resultado no painel, inclusive dados pessoais se a query trouxer. Ela fica só na sua tela e não entra no contexto do Claude.

## Atualizar e remover

```bash
claude plugin update query-pane
```

```bash
claude plugin uninstall query-pane
```

## Desenvolver

```bash
git clone https://github.com/iagodemacedo/query-pane && cd query-pane
```

```bash
claude --plugin-dir .
```

Salvar um arquivo recarrega o mod na sessão. Antes de um commit, rode `claude plugin validate .` e `claude plugin test .`.

## Licença

MIT
