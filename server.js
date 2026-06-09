const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── PASTAS ───────────────────────────────────────────────────────────────────
const DATA_DIR    = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const BACKUP_DIR  = path.join(DATA_DIR, 'backups');
[DATA_DIR, UPLOADS_DIR, BACKUP_DIR].forEach(d => !fs.existsSync(d) && fs.mkdirSync(d, { recursive: true }));

// ─── BANCO ────────────────────────────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'shoecrm.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS produtos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nome        TEXT    NOT NULL,
    modelo      TEXT    NOT NULL UNIQUE,
    descricao   TEXT,
    preco       REAL    NOT NULL,
    tamanhos    TEXT    NOT NULL DEFAULT '[]',
    cores       TEXT    NOT NULL DEFAULT '[]',
    imagens     TEXT    NOT NULL DEFAULT '[]',
    ativo       INTEGER NOT NULL DEFAULT 1,
    criado_em   TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS estoque (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    produto_id    INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
    tamanho       TEXT    NOT NULL,
    cor           TEXT    NOT NULL,
    quantidade    INTEGER NOT NULL DEFAULT 0,
    atualizado_em TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(produto_id, tamanho, cor)
  );
  CREATE TABLE IF NOT EXISTS vendas (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_nome  TEXT    NOT NULL,
    cliente_tel   TEXT    NOT NULL,
    cliente_end   TEXT,
    produto_id    INTEGER REFERENCES produtos(id),
    produto_nome  TEXT,
    tamanho       TEXT,
    cor           TEXT,
    quantidade    INTEGER NOT NULL DEFAULT 1,
    preco_unit    REAL,
    total         REAL,
    pagamento     TEXT,
    status        TEXT    NOT NULL DEFAULT 'pendente',
    observacoes   TEXT,
    criado_em     TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS envios (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    venda_id       INTEGER NOT NULL UNIQUE REFERENCES vendas(id) ON DELETE CASCADE,
    status         TEXT    NOT NULL DEFAULT 'aguardando',
    rastreio       TEXT,
    transportadora TEXT,
    observacao     TEXT,
    atualizado_em  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
`);

// ─── PROTEÇÃO DO ADMIN ────────────────────────────────────────────────────────
// Senha definida pela variável de ambiente ADMIN_PASS no Railway
// Se não configurar, a senha padrão é "admin123" — troque antes de usar!
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

app.use('/admin.html', (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="ShoeCRM Admin"');
    return res.status(401).send('🔒 Acesso restrito. Informe a senha de administrador.');
  }
  const decoded = Buffer.from(auth.split(' ')[1], 'base64').toString();
  const pass = decoded.split(':').slice(1).join(':'); // pega tudo após o primeiro ':'
  if (pass !== ADMIN_PASS) {
    res.setHeader('WWW-Authenticate', 'Basic realm="ShoeCRM Admin"');
    return res.status(401).send('❌ Senha incorreta.');
  }
  next();
});

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// Redireciona raiz para a loja
app.get('/', (req, res) => res.redirect('/loja.html'));

// ─── UPLOAD DE IMAGENS ────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `img_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg','.jpeg','.png','.webp','.gif'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  PRODUTOS
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/produtos', (req, res) => {
  const { ativo, q } = req.query;
  let sql = 'SELECT * FROM produtos WHERE 1=1';
  const params = [];
  if (ativo !== undefined) { sql += ' AND ativo=?'; params.push(Number(ativo)); }
  if (q) { sql += ' AND (nome LIKE ? OR modelo LIKE ?)'; params.push(`%${q}%`,`%${q}%`); }
  sql += ' ORDER BY nome';
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/produtos/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(req.params.id);
  p ? res.json(p) : res.status(404).json({ error: 'Não encontrado' });
});

app.post('/api/produtos', (req, res) => {
  const { nome, modelo, descricao, preco, tamanhos, cores, ativo } = req.body;
  if (!nome || !modelo || preco == null) return res.status(400).json({ error: 'nome, modelo e preco são obrigatórios' });
  try {
    const r = db.prepare(
      'INSERT INTO produtos (nome,modelo,descricao,preco,tamanhos,cores,ativo) VALUES (?,?,?,?,?,?,?)'
    ).run(nome, modelo, descricao||null, preco,
          JSON.stringify(tamanhos||[]), JSON.stringify(cores||[]), ativo??1);
    res.status(201).json(db.prepare('SELECT * FROM produtos WHERE id=?').get(r.lastInsertRowid));
  } catch(e) {
    res.status(409).json({ error: e.message });
  }
});

app.put('/api/produtos/:id', (req, res) => {
  const { nome, modelo, descricao, preco, tamanhos, cores, ativo } = req.body;
  db.prepare(
    'UPDATE produtos SET nome=?,modelo=?,descricao=?,preco=?,tamanhos=?,cores=?,ativo=? WHERE id=?'
  ).run(nome, modelo, descricao||null, preco,
        JSON.stringify(tamanhos||[]), JSON.stringify(cores||[]), ativo??1, req.params.id);
  res.json(db.prepare('SELECT * FROM produtos WHERE id=?').get(req.params.id));
});

app.delete('/api/produtos/:id', (req, res) => {
  const p = db.prepare('SELECT imagens FROM produtos WHERE id=?').get(req.params.id);
  if (p) {
    (JSON.parse(p.imagens||'[]')).forEach(img => {
      const fp = path.join(UPLOADS_DIR, path.basename(img));
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    });
  }
  db.prepare('DELETE FROM produtos WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/produtos/:id/imagens', upload.array('imagens', 8), (req, res) => {
  const p = db.prepare('SELECT imagens FROM produtos WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Produto não encontrado' });
  const existentes = JSON.parse(p.imagens || '[]');
  const novas = req.files.map(f => `/uploads/${f.filename}`);
  const todas = [...existentes, ...novas];
  db.prepare('UPDATE produtos SET imagens=? WHERE id=?').run(JSON.stringify(todas), req.params.id);
  res.json({ imagens: todas });
});

app.delete('/api/produtos/:id/imagens', (req, res) => {
  const { url } = req.body;
  const p = db.prepare('SELECT imagens FROM produtos WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Não encontrado' });
  const fp = path.join(UPLOADS_DIR, path.basename(url));
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  const novas = JSON.parse(p.imagens||'[]').filter(i => i !== url);
  db.prepare('UPDATE produtos SET imagens=? WHERE id=?').run(JSON.stringify(novas), req.params.id);
  res.json({ imagens: novas });
});

// ════════════════════════════════════════════════════════════════════════════
//  ESTOQUE
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/estoque', (req, res) => {
  const { produto_id, q } = req.query;
  let sql = `SELECT e.*, p.nome as produto_nome FROM estoque e LEFT JOIN produtos p ON e.produto_id=p.id WHERE 1=1`;
  const params = [];
  if (produto_id) { sql += ' AND e.produto_id=?'; params.push(produto_id); }
  if (q) { sql += ' AND p.nome LIKE ?'; params.push(`%${q}%`); }
  sql += ' ORDER BY p.nome, e.tamanho, e.cor';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/estoque', (req, res) => {
  const { produto_id, tamanho, cor, quantidade, operacao } = req.body;
  if (!produto_id || !tamanho || !cor) return res.status(400).json({ error: 'produto_id, tamanho e cor obrigatórios' });
  const existing = db.prepare('SELECT * FROM estoque WHERE produto_id=? AND tamanho=? AND cor=?').get(produto_id, tamanho, cor);
  let novaQtd = Number(quantidade) || 0;
  if (existing) {
    if (operacao === 'add') novaQtd = existing.quantidade + novaQtd;
    else if (operacao === 'sub') novaQtd = Math.max(0, existing.quantidade - novaQtd);
    db.prepare("UPDATE estoque SET quantidade=?,atualizado_em=datetime('now','localtime') WHERE produto_id=? AND tamanho=? AND cor=?")
      .run(novaQtd, produto_id, tamanho, cor);
  } else {
    db.prepare('INSERT INTO estoque (produto_id,tamanho,cor,quantidade) VALUES (?,?,?,?)').run(produto_id, tamanho, cor, novaQtd);
  }
  res.json(db.prepare('SELECT * FROM estoque WHERE produto_id=? AND tamanho=? AND cor=?').get(produto_id, tamanho, cor));
});

app.get('/api/estoque/produto/:id', (req, res) => {
  res.json(db.prepare('SELECT tamanho, cor, quantidade FROM estoque WHERE produto_id=? AND quantidade>0').all(req.params.id));
});

// ════════════════════════════════════════════════════════════════════════════
//  VENDAS
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/vendas', (req, res) => {
  const { status, q } = req.query;
  let sql = 'SELECT * FROM vendas WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status=?'; params.push(status); }
  if (q) { sql += ' AND (cliente_nome LIKE ? OR cliente_tel LIKE ?)'; params.push(`%${q}%`,`%${q}%`); }
  sql += ' ORDER BY id DESC';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/vendas', (req, res) => {
  const { cliente_nome, cliente_tel, cliente_end, produto_id, produto_nome, tamanho, cor, quantidade, preco_unit, total, pagamento, status, observacoes } = req.body;
  if (!cliente_nome || !cliente_tel) return res.status(400).json({ error: 'Nome e telefone obrigatórios' });
  const r = db.prepare(
    'INSERT INTO vendas (cliente_nome,cliente_tel,cliente_end,produto_id,produto_nome,tamanho,cor,quantidade,preco_unit,total,pagamento,status,observacoes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(cliente_nome, cliente_tel, cliente_end||null, produto_id||null, produto_nome||null, tamanho||null, cor||null, quantidade||1, preco_unit||null, total||null, pagamento||null, status||'pendente', observacoes||null);
  const vid = r.lastInsertRowid;
  db.prepare('INSERT OR IGNORE INTO envios (venda_id,status) VALUES (?,?)').run(vid, 'aguardando');
  res.status(201).json(db.prepare('SELECT * FROM vendas WHERE id=?').get(vid));
});

app.put('/api/vendas/:id', (req, res) => {
  const { cliente_nome, cliente_tel, cliente_end, produto_id, produto_nome, tamanho, cor, quantidade, preco_unit, total, pagamento, status, observacoes } = req.body;
  db.prepare(
    'UPDATE vendas SET cliente_nome=?,cliente_tel=?,cliente_end=?,produto_id=?,produto_nome=?,tamanho=?,cor=?,quantidade=?,preco_unit=?,total=?,pagamento=?,status=?,observacoes=? WHERE id=?'
  ).run(cliente_nome, cliente_tel, cliente_end||null, produto_id||null, produto_nome||null, tamanho||null, cor||null, quantidade, preco_unit, total, pagamento, status, observacoes||null, req.params.id);
  res.json(db.prepare('SELECT * FROM vendas WHERE id=?').get(req.params.id));
});

app.delete('/api/vendas/:id', (req, res) => {
  db.prepare('DELETE FROM vendas WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
//  ENVIOS
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/envios', (req, res) => {
  const { status } = req.query;
  let sql = `SELECT e.*, v.cliente_nome, v.cliente_tel, v.produto_nome,
             v.tamanho, v.cor, v.cliente_end, v.total
             FROM envios e LEFT JOIN vendas v ON e.venda_id=v.id WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND e.status=?'; params.push(status); }
  sql += ' ORDER BY e.id DESC';
  res.json(db.prepare(sql).all(...params));
});

app.put('/api/envios/:venda_id', (req, res) => {
  const { status, rastreio, transportadora, observacao } = req.body;
  db.prepare(`INSERT INTO envios (venda_id,status,rastreio,transportadora,observacao)
              VALUES (?,?,?,?,?)
              ON CONFLICT(venda_id) DO UPDATE SET
              status=excluded.status, rastreio=excluded.rastreio,
              transportadora=excluded.transportadora, observacao=excluded.observacao,
              atualizado_em=datetime('now','localtime')`)
    .run(req.params.venda_id, status, rastreio||null, transportadora||null, observacao||null);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
//  DASHBOARD
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/dashboard', (req, res) => {
  res.json({
    total_produtos:   db.prepare('SELECT COUNT(*) as c FROM produtos WHERE ativo=1').get().c,
    total_vendas:     db.prepare('SELECT COUNT(*) as c FROM vendas').get().c,
    faturamento:      db.prepare("SELECT COALESCE(SUM(total),0) as t FROM vendas WHERE status='pago'").get().t,
    envios_pendentes: db.prepare("SELECT COUNT(*) as c FROM envios WHERE status NOT IN ('entregue')").get().c,
    vendas_recentes:  db.prepare(`SELECT v.*, e.status as env_status FROM vendas v
                                  LEFT JOIN envios e ON v.id=e.venda_id
                                  ORDER BY v.id DESC LIMIT 8`).all()
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  BACKUP / EXPORT
// ════════════════════════════════════════════════════════════════════════════

// Função interna que gera o Excel e salva em disco
function gerarBackupXlsx(nomeArquivo) {
  const wb = XLSX.utils.book_new();
  const tables = {
    'Produtos': 'SELECT p.*, (SELECT COALESCE(SUM(e.quantidade),0) FROM estoque e WHERE e.produto_id=p.id) as estoque_total FROM produtos p',
    'Estoque':  'SELECT e.*, p.nome as produto_nome FROM estoque e LEFT JOIN produtos p ON e.produto_id=p.id',
    'Vendas':   'SELECT * FROM vendas',
    'Envios':   'SELECT en.*, v.cliente_nome, v.produto_nome FROM envios en LEFT JOIN vendas v ON en.venda_id=v.id'
  };
  Object.entries(tables).forEach(([name, sql]) => {
    const rows = db.prepare(sql).all();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name);
  });
  const filePath = path.join(BACKUP_DIR, nomeArquivo);
  XLSX.writeFile(wb, filePath);
  return filePath;
}

// Limpa backups antigos — mantém apenas os 4 mais recentes
function limparBackupsAntigos() {
  const arquivos = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.xlsx'))
    .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtime.getTime() }))
    .sort((a, b) => b.time - a.time);
  arquivos.slice(4).forEach(f => {
    fs.unlinkSync(path.join(BACKUP_DIR, f.name));
    console.log(`🗑️  Backup antigo removido: ${f.name}`);
  });
}

// Download manual do Excel
app.get('/api/backup/xlsx', (req, res) => {
  const buf = (() => {
    const wb = XLSX.utils.book_new();
    const tables = {
      'Produtos': 'SELECT p.*, (SELECT COALESCE(SUM(e.quantidade),0) FROM estoque e WHERE e.produto_id=p.id) as estoque_total FROM produtos p',
      'Estoque':  'SELECT e.*, p.nome as produto_nome FROM estoque e LEFT JOIN produtos p ON e.produto_id=p.id',
      'Vendas':   'SELECT * FROM vendas',
      'Envios':   'SELECT en.*, v.cliente_nome, v.produto_nome FROM envios en LEFT JOIN vendas v ON en.venda_id=v.id'
    };
    Object.entries(tables).forEach(([name, sql]) => {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(db.prepare(sql).all()), name);
    });
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  })();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="shoecrm_export.xlsx"');
  res.send(buf);
});

// Download do banco completo
app.get('/api/backup/db', (req, res) => {
  const dest = path.join(DATA_DIR, `backup_${Date.now()}.db`);
  db.backup(dest).then(() => {
    res.download(dest, 'shoecrm.db', () => fs.unlinkSync(dest));
  });
});

// Download SQL
app.get('/api/backup/sql', (req, res) => {
  const tables = ['produtos','estoque','vendas','envios'];
  let sql = `-- ShoeCRM Backup SQL\n-- ${new Date().toLocaleString('pt-BR')}\n\n`;
  tables.forEach(table => {
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    rows.forEach(row => {
      const cols = Object.keys(row);
      const vals = cols.map(c => row[c] == null ? 'NULL' : `'${String(row[c]).replace(/'/g,"''")}'`);
      sql += `INSERT INTO ${table} (${cols.join(',')}) VALUES (${vals.join(',')});\n`;
    });
    if (rows.length) sql += '\n';
  });
  res.setHeader('Content-Type','text/plain');
  res.setHeader('Content-Disposition','attachment; filename="shoecrm_backup.sql"');
  res.send(sql);
});

// Lista backups automáticos salvos no servidor
app.get('/api/backup/lista', (req, res) => {
  const arquivos = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.xlsx'))
    .map(f => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { nome: f, tamanho: stat.size, data: stat.mtime };
    })
    .sort((a, b) => new Date(b.data) - new Date(a.data));
  res.json(arquivos);
});

// Download de um backup salvo pelo nome
app.get('/api/backup/arquivo/:nome', (req, res) => {
  const filePath = path.join(BACKUP_DIR, path.basename(req.params.nome));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Arquivo não encontrado' });
  res.download(filePath);
});

// ════════════════════════════════════════════════════════════════════════════
//  BACKUP AUTOMÁTICO SEMANAL (toda domingo às 02:00)
// ════════════════════════════════════════════════════════════════════════════
function agendarBackupSemanal() {
  const INTERVALO_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias em ms

  function executarBackup() {
    try {
      const data = new Date().toISOString().slice(0,10);
      const nome = `backup_${data}.xlsx`;
      gerarBackupXlsx(nome);
      limparBackupsAntigos();
      console.log(`✅ Backup automático criado: ${nome}`);
    } catch(e) {
      console.error('❌ Erro no backup automático:', e.message);
    }
  }

  // Calcula quantos ms faltam para o próximo domingo às 02:00
  function msParaProximoDomingo() {
    const agora = new Date();
    const proximo = new Date(agora);
    proximo.setHours(2, 0, 0, 0);
    // Avança até o próximo domingo (dia 0)
    const diasParaDomingo = (7 - agora.getDay()) % 7 || 7;
    proximo.setDate(agora.getDate() + diasParaDomingo);
    return proximo.getTime() - agora.getTime();
  }

  // Agenda o primeiro backup e depois repete a cada 7 dias
  setTimeout(() => {
    executarBackup();
    setInterval(executarBackup, INTERVALO_MS);
  }, msParaProximoDomingo());

  const diasRestantes = Math.round(msParaProximoDomingo() / (1000 * 60 * 60 * 24));
  console.log(`📅 Backup automático agendado — próximo em ${diasRestantes} dia(s)`);
}

agendarBackupSemanal();

// ─── SEED (dados de exemplo na 1ª execução) ───────────────────────────────────
const seedCheck = db.prepare("SELECT COUNT(*) as c FROM produtos").get();
if (seedCheck.c === 0) {
  const ins    = db.prepare('INSERT INTO produtos (nome,modelo,descricao,preco,tamanhos,cores,ativo) VALUES (?,?,?,?,?,?,?)');
  const insEst = db.prepare('INSERT OR IGNORE INTO estoque (produto_id,tamanho,cor,quantidade) VALUES (?,?,?,?)');
  db.transaction(() => {
    const p1 = ins.run('Scarpin Elegance','SCA-001','Scarpin clássico com salto fino 7cm',159.90,'["35","36","37","38","39","40"]','["Preto","Nude","Vermelho"]',1);
    const p2 = ins.run('Sandália Boho','SAN-002','Sandália rasteira estilo boho',89.90,'["35","36","37","38","39","40","41"]','["Caramelo","Branco","Preto"]',1);
    const p3 = ins.run('Tênis Comfort','TEN-003','Tênis casual confortável',129.90,'["36","37","38","39","40","41","42"]','["Branco","Rosa","Azul"]',1);
    [[p1.lastInsertRowid,'37','Preto',5],[p1.lastInsertRowid,'38','Nude',3],[p1.lastInsertRowid,'37','Vermelho',2],
     [p2.lastInsertRowid,'37','Caramelo',6],[p2.lastInsertRowid,'38','Branco',4],
     [p3.lastInsertRowid,'38','Branco',8],[p3.lastInsertRowid,'39','Rosa',5]].forEach(a=>insEst.run(...a));
  })();
}

app.listen(PORT, () => console.log(`✅ ShoeCRM rodando em http://localhost:${PORT}`));
