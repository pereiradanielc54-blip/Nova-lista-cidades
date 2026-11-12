# União Transportes — Consulta de Filiais

Aplicação web instalável (PWA) para consultar qual filial atende uma cidade, com dados compartilhados pelo Supabase.

## Recursos
- Busca por cidade ignorando diferenças de maiúsculas e acentos.
- Até três sugestões de cidades cadastradas.
- Cadastro, edição e exclusão por contas autorizadas.
- Sincronização compartilhada via Supabase; cache local apenas como contingência de leitura.
- Interface responsiva e instalação no Android pelo navegador.
- Service worker que prioriza recursos atualizados pela rede e usa cache como fallback offline.

## Arquitetura
- Front-end estático em `index.html`, servido pelo Vite.
- Autenticação e banco de dados no Supabase.
- Tabela `city_directory`: registro principal `id = 1`, coluna `records`.
- Tabela `city_directory_editors`: usuários autorizados a editar.
- A escrita deve ser protegida por políticas RLS no Supabase. A chave publishable no navegador não substitui as políticas do banco.

## Executar localmente
Requer Node.js compatível com Vite 6.

```bash
npm install
npm run build
npm run dev
```

## Publicação no Vercel
Conecte este repositório a um projeto Vercel e configure a raiz do projeto como a raiz do repositório. O comando de build é `npm run build`; a saída é `dist`. Esta aplicação não depende do GitHub Pages.

## Cadastro de usuários administrativos

A aba **Usuários** cria contas no Supabase Auth pela função de servidor `api/admin/users.js`. Somente quem está em `city_directory_admins` pode criar contas. Os novos usuários entram em `city_directory_editors`, mas NÃO em `city_directory_admins`.

O administrador principal pode cadastrar e alterar filiais, cadastrar/alterar cidades e criar usuários. Os usuários criados por ele podem apenas cadastrar/alterar cidades. A aba de filiais e a aba de usuários ficam ocultas para esses usuários. Um trigger no banco também bloqueia alterações de nomes, inclusão ou remoção de filiais por usuários comuns, mesmo que tentem chamar a API diretamente.

**Migração obrigatória:** aplique `supabase/migrations/20261111_admin_city_editor_roles.sql` no SQL Editor do Supabase antes de usar o novo controle de permissões. Ela cria a tabela de administradores, promove somente a conta `pereiradanielc54@gmail.com` a administrador principal e instala a proteção no banco. Usuários cadastrados depois da migração recebem apenas permissão de edição de cidades.

Antes de usar o cadastro, configure na Vercel a variável de ambiente **`SUPABASE_SECRET_KEY`** com a chave secreta do projeto Supabase (Settings → API Keys → Secret keys). Não use o prefixo `NEXT_PUBLIC_` e não coloque essa chave em arquivos do repositório. Habilite a variável para Production e Preview e faça um novo deploy.

## Configuração do Supabase
Confira se as tabelas `city_directory` e `city_directory_editors` existem, se o registro `id = 1` está inicializado e se as políticas RLS permitem leitura conforme a necessidade do negócio, mas somente atualização por usuários autenticados cadastrados em `city_directory_editors`. Teste também o comportamento de usuário não autorizado.

## PWA e atualização
O service worker usa uma versão de cache identificada em `sw.js`. Ao publicar uma nova versão, incremente-a para invalidar recursos antigos. Para testar atualizações, feche e reabra a aplicação instalada ou atualize o site; se persistir conteúdo antigo, limpe os dados do site no navegador.

## Segurança e dados
- O cache local não é a fonte oficial e não deve ser usado para editar quando o banco compartilhado estiver indisponível.
- Nunca coloque chaves secretas/service-role do Supabase no navegador.
- A proteção real depende das políticas RLS e de testes de permissões diretamente no banco.
