// Публичная конфигурация фронтенда.
// Publishable key Supabase допустимо хранить в клиентском коде;
// Доступ к данным ограничивается членством и RLS в
// supabase/migrations/20261117_require_member_login.sql.
window.ROADMAP_CONFIG = {
  supabaseUrl: "https://dxdgxtvblhoduywqmphm.supabase.co",
  supabaseKey: "sb_publishable_sD8w8n87eK-UHGLBRfRZhA_HPZ6HPTN",
  roadmapId: "main",
  // На сайте вводится логин; в Supabase аккаунт имеет адрес <логин>@roadmap.invalid.
  loginDomain: "roadmap.invalid"
};
