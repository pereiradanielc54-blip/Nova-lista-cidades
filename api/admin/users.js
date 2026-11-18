import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://ioxxlfcygmkrktesocqn.supabase.co";

function send(res, status, payload) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(status).json(payload);
}

function readBody(req) {
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body && typeof req.body === "object" ? req.body : {};
}

function displayName(user, fallbackEmail = "") {
  const metadata = user?.user_metadata || {};
  return String(
    metadata.full_name ||
    metadata.name ||
    metadata.display_name ||
    fallbackEmail ||
    user?.email ||
    "Usuário"
  ).trim();
}

export default async function handler(req, res) {
  const allowedMethods = ["GET", "POST", "PATCH", "DELETE"];
  if (!allowedMethods.includes(req.method)) {
    res.setHeader("Allow", allowedMethods.join(", "));
    return send(res, 405, { error: "Método não permitido." });
  }

  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!secretKey) {
    return send(res, 503, {
      error: "O gerenciamento de usuários ainda não foi configurado no servidor. Adicione SUPABASE_SECRET_KEY nas variáveis da Vercel.",
    });
  }

  const authorization = req.headers.authorization || "";
  const tokenMatch = authorization.match(/^Bearer\s+(.+)$/i);
  if (!tokenMatch) {
    return send(res, 401, { error: "Sessão administrativa não encontrada. Entre novamente." });
  }

  try {
    const body = readBody(req);
    const supabaseAdmin = createClient(SUPABASE_URL, secretKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });

    // Valida a sessão antes de qualquer operação administrativa.
    const { data: authData, error: authError } =
      await supabaseAdmin.auth.getUser(tokenMatch[1]);
    if (authError || !authData?.user) {
      return send(res, 401, { error: "Sua sessão expirou. Entre novamente." });
    }

    // Todas as ações desta API são exclusivas do administrador principal.
    const { data: adminUser, error: adminError } = await supabaseAdmin
      .from("city_directory_admins")
      .select("user_id")
      .eq("user_id", authData.user.id)
      .maybeSingle();

    if (adminError) {
      console.error("Falha ao validar permissão de administrador:", adminError.message);
      return send(res, 503, {
        error: "As permissões ainda não foram configuradas. Aplique a migração de funções do painel.",
      });
    }
    if (!adminUser) {
      return send(res, 403, {
        error: "Somente o administrador principal pode gerenciar usuários.",
      });
    }

    // GET: lista apenas usuários autorizados como editores de cidades.
    // Contas ADM são excluídas mesmo que também tenham registro em city_directory_editors.
    if (req.method === "GET") {
      const [editorsResult, adminsResult] = await Promise.all([
        supabaseAdmin
          .from("city_directory_editors")
          .select("user_id,email"),
        supabaseAdmin
          .from("city_directory_admins")
          .select("user_id"),
      ]);

      if (editorsResult.error || adminsResult.error) {
        console.error("Falha ao carregar lista de usuários:", {
          editors: editorsResult.error?.message || null,
          admins: adminsResult.error?.message || null,
        });
        return send(res, 500, { error: "Não foi possível carregar os usuários autorizados." });
      }

      const adminIds = new Set((adminsResult.data || []).map(row => row.user_id));
      const editorRows = (editorsResult.data || []).filter(
        row => row.user_id && !adminIds.has(row.user_id)
      );

      const authUsers = [];
      for (let page = 1; page <= 20; page += 1) {
        const { data: pageData, error: listError } =
          await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
        if (listError) {
          console.error("Falha ao consultar contas Auth:", listError.message);
          return send(res, 500, { error: "Não foi possível consultar as contas de acesso." });
        }
        const pageUsers = pageData?.users || [];
        authUsers.push(...pageUsers);
        if (pageUsers.length < 1000) break;
      }

      const authById = new Map(authUsers.map(user => [user.id, user]));
      const users = editorRows.map(row => {
        const user = authById.get(row.user_id);
        const email = user?.email || row.email || "";
        return {
          id: row.user_id,
          name: displayName(user, email),
          email,
          createdAt: user?.created_at || null,
        };
      }).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

      return send(res, 200, { ok: true, users });
    }

    // PATCH: altera somente o nome de exibição da própria conta ADM.
    if (req.method === "PATCH") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name.length < 2 || name.length > 100) {
        return send(res, 400, { error: "Informe um nome entre 2 e 100 caracteres." });
      }

      const previousMetadata =
        authData.user.user_metadata && typeof authData.user.user_metadata === "object"
          ? authData.user.user_metadata
          : {};
      const { data: updatedData, error: updateError } =
        await supabaseAdmin.auth.admin.updateUserById(authData.user.id, {
          user_metadata: {
            ...previousMetadata,
            full_name: name,
            name,
          },
        });

      if (updateError || !updatedData?.user) {
        console.error("Falha ao alterar nome do administrador:", updateError?.message);
        return send(res, 500, { error: "Não foi possível atualizar seu nome. Tente novamente." });
      }

      return send(res, 200, {
        ok: true,
        user: {
          id: updatedData.user.id,
          email: updatedData.user.email,
          name,
        },
      });
    }

    // DELETE: remove a permissão e exclui a conta de acesso do editor selecionado.
    if (req.method === "DELETE") {
      const userId = typeof body.userId === "string" ? body.userId.trim() : "";
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
        return send(res, 400, { error: "Usuário selecionado inválido." });
      }
      if (userId === authData.user.id) {
        return send(res, 400, { error: "Você não pode remover seu próprio acesso de administrador por esta opção." });
      }

      const { data: targetEditor, error: editorError } = await supabaseAdmin
        .from("city_directory_editors")
        .select("user_id")
        .eq("user_id", userId)
        .maybeSingle();

      if (editorError) {
        console.error("Falha ao localizar editor:", editorError.message);
        return send(res, 500, { error: "Não foi possível localizar esse usuário." });
      }
      if (!targetEditor) {
        return send(res, 404, { error: "Esse usuário não está mais autorizado no painel." });
      }

      const { data: targetAdmin, error: targetAdminError } = await supabaseAdmin
        .from("city_directory_admins")
        .select("user_id")
        .eq("user_id", userId)
        .maybeSingle();

      if (targetAdminError) {
        console.error("Falha ao conferir papel do usuário:", targetAdminError.message);
        return send(res, 500, { error: "Não foi possível verificar o nível de acesso desse usuário." });
      }
      if (targetAdmin) {
        return send(res, 403, { error: "A conta de administrador não pode ser removida por esta lista." });
      }

      // Revoga primeiro a autorização do painel. Mesmo se a exclusão Auth falhar,
      // a conta deixa de ter a permissão exigida pelo login.
      const { error: revokeError } = await supabaseAdmin
        .from("city_directory_editors")
        .delete()
        .eq("user_id", userId);

      if (revokeError) {
        console.error("Falha ao revogar acesso do editor:", revokeError.message);
        return send(res, 500, { error: "Não foi possível revogar o acesso desse usuário." });
      }

      const { error: deleteError } =
        await supabaseAdmin.auth.admin.deleteUser(userId);

      if (deleteError && !/not found|does not exist/i.test(deleteError.message || "")) {
        console.error("Acesso revogado, mas a conta Auth não pôde ser excluída:", deleteError.message);
        return send(res, 200, {
          ok: true,
          warning: "A permissão do painel foi revogada, mas a conta de autenticação não pôde ser excluída automaticamente.",
        });
      }

      return send(res, 200, { ok: true });
    }

    // POST: mantém o fluxo já utilizado para criar novos editores.
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (name.length < 2 || name.length > 100) {
      return send(res, 400, { error: "Informe um nome entre 2 e 100 caracteres." });
    }
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return send(res, 400, { error: "Informe um e-mail válido." });
    }
    if (password.length < 10 || password.length > 72) {
      return send(res, 400, { error: "A senha inicial deve ter entre 10 e 72 caracteres." });
    }

    const { data: createdData, error: createError } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: name, name },
      });

    if (createError || !createdData?.user) {
      const code = createError?.code || "";
      const duplicate =
        code === "email_exists" ||
        /already (?:been )?registered|already exists|email exists|duplicate/i.test(
          createError?.message || ""
        );
      return send(res, duplicate ? 409 : 400, {
        error: duplicate
          ? "Já existe uma conta com esse e-mail."
          : "Não foi possível criar a conta. Confira os dados e tente novamente.",
      });
    }

    const newUser = createdData.user;
    const { error: grantError } = await supabaseAdmin
      .from("city_directory_editors")
      .insert({ user_id: newUser.id, email: newUser.email });

    if (grantError) {
      const { error: rollbackError } =
        await supabaseAdmin.auth.admin.deleteUser(newUser.id);
      console.error("Falha ao autorizar o novo usuário:", {
        grantError: grantError.message,
        rollbackError: rollbackError?.message || null,
      });
      return send(res, 500, {
        error: "A conta não recebeu a autorização do painel. Nenhum acesso foi liberado.",
      });
    }

    return send(res, 201, {
      ok: true,
      user: {
        id: newUser.id,
        email: newUser.email,
        name,
      },
    });
  } catch (error) {
    console.error("Erro ao gerenciar usuários administrativos:", error);
    return send(res, 500, { error: "Ocorreu um erro ao gerenciar usuários. Tente novamente." });
  }
}
