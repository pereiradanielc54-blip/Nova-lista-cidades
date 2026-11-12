import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://ioxxlfcygmkrktesocqn.supabase.co";

function send(res, status, payload) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(status).json(payload);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "Método não permitido." });
  }

  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!secretKey) {
    return send(res, 503, {
      error: "O cadastro de usuários ainda não foi configurado no servidor. Adicione SUPABASE_SECRET_KEY nas variáveis da Vercel.",
    });
  }

  const authorization = req.headers.authorization || "";
  const tokenMatch = authorization.match(/^Bearer\s+(.+)$/i);
  if (!tokenMatch) {
    return send(res, 401, { error: "Sessão administrativa não encontrada. Entre novamente." });
  }

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
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

    const supabaseAdmin = createClient(SUPABASE_URL, secretKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });

    // Valida a sessão enviada pelo painel antes de qualquer operação administrativa.
    const { data: authData, error: authError } =
      await supabaseAdmin.auth.getUser(tokenMatch[1]);
    if (authError || !authData?.user) {
      return send(res, 401, { error: "Sua sessão expirou. Entre novamente." });
    }

    // Somente administradores principais podem criar contas.
    const { data: adminUser, error: adminError } = await supabaseAdmin
      .from("city_directory_admins")
      .select("user_id")
      .eq("user_id", authData.user.id)
      .maybeSingle();

    if (adminError) {
      console.error("Falha ao validar permissão de administrador:", adminError.message);
      return send(res, 503, { error: "As permissões ainda não foram configuradas. Aplique a migração de funções do painel." });
    }
    if (!adminUser) {
      return send(res, 403, { error: "Somente o administrador principal pode cadastrar novos usuários." });
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
      return send(
        res,
        duplicate ? 409 : 400,
        {
          error: duplicate
            ? "Já existe uma conta com esse e-mail."
            : "Não foi possível criar a conta. Confira os dados e tente novamente.",
        }
      );
    }

    const newUser = createdData.user;

    // A conta só é considerada criada depois de receber a mesma permissão
    // de edição que o painel exige no login.
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
    console.error("Erro ao cadastrar usuário administrativo:", error);
    return send(res, 500, { error: "Ocorreu um erro ao cadastrar o usuário. Tente novamente." });
  }
}
