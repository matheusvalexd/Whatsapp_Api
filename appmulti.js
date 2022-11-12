const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const socketIO = require('socket.io');
const qrcode = require('qrcode');
const http = require('http');
const fs = require('fs');
const { phoneNumberFormatter } = require('./helpers/formatter');
const fileUpload = require('express-fileupload');
const axios = require('axios');
const port = process.env.PORT || 8000;

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const dirQrcode = './qrcode'
if (!fs. existsSync(dirQrcode)){
  fs.mkdirSync(dirQrcode)
}

app.use(express.json());
app.use(express.urlencoded({
  extended: true
}));

app.use(fileUpload({
  debug: false
}));

app.get('/', (req, res) => {
  res.sendFile('index-multiple-account.html', {
    root: __dirname
  });
});

const sessions = [];
const SESSIONS_FILE = './whatsapp-sessions.json';

const createSessionsFileIfNotExists = function() {
  if (!fs.existsSync(SESSIONS_FILE)) {
    try {
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify([]));
      console.log('Sessions file created successfully.');
    } catch(err) {
      console.log('Failed to create sessions file: ', err);
    }
  }
}

createSessionsFileIfNotExists();

const setSessionsFile = function(sessions) {
  fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions), function(err) {
    if (err) {
      console.log(err);
    }
  });
}

const getSessionsFile = function() {
  return JSON.parse(fs.readFileSync(SESSIONS_FILE));
}

const createSession = function(id, token) {
  console.log('Criando sessão: ' + id);
  const client = new Client({
    restartOnAuthFail: true,
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process', // <- this one doesn't works in Windows
        '--disable-gpu'
      ],
    },
    authStrategy: new LocalAuth({
      clientId: id
    })
  });

  client.initialize();

  if (!fs.existsSync(dirQrcode + '/' + id)){
    fs.mkdirSync(dirQrcode + '/' + id)
  }

  client.on('qr', async (qr) => {
    console.log ('QRCode recebido', qr);
    const bufferImage = await qrcode.toDataURL(qr);
    var base64Data = bufferImage.replace(/^data:image\/png;base64,/,"");
    try {
      fs.unlinkSync(dirQrCode + '/' + id + '/qrcode.png');
    } catch(e){
      console.log('Aplicacao Wpp')
    } finally {
      try{
        fs.writeFileSync(dirQrcode + '/' + id + '/qrcode.png', base64Data, 'base64');
      } catch(e){
        console.log('Aplicacao Wpp')}
    }
    qrcode.toDataURL(qr, (err, url) => {
      io.emit('qr', {id: id, src: url });
      io.emit('message', {id: id, text: 'QRCode recebido, aponte a camera do seu celular!'});
    });
  });

  client.on('ready', async () => {
    io.emit('ready', { id: id });
    console.log ('Dispositivo pronto: ' + id);
    io.emit('qr', './check.svg');
    io.emit('message', {id: id, text: 'Dispositivo pronto!'});
    try {
      fs.unlinkSync(dirQrcode + '/' + id + '/qrcode.png');
    } catch(e) {
      console.log('Aplicacao wpp - https://matheusvale.com')
    }

    const savedSessions = getSessionsFile();
    const sessionIndex = savedSessions.findIndex(sess => sess.id == id);
    savedSessions[sessionIndex].ready = true;
    setSessionsFile(savedSessions);
  });

  client.on('authenticated', () => {
    io.emit('authenticated', { id: id });
    io.emit('message', { id: id, text: 'Whatsapp autenticado!' });
  });

  client.on('auth_failure', function() {
    io.emit('message', { id: id, text: 'Falha na autenticação, reiniciando...' });
  });

  client.on('disconnected', (reason) => {
    io.emit('message', { id: id, text: 'Whatsapp is disconnected!' });
    client.destroy();
    client.initialize();

    // Menghapus pada file sessions
    const savedSessions = getSessionsFile();
    const sessionIndex = savedSessions.findIndex(sess => sess.id == id);
    savedSessions.splice(sessionIndex, 1);
    setSessionsFile(savedSessions);

    io.emit('remove-session', id);
  });

  // Tambahkan client ke sessions
  sessions.push({
    id: id,
    token: token,
    client: client
  });

  // Menambahkan session ke file
  const savedSessions = getSessionsFile();
  const sessionIndex = savedSessions.findIndex(sess => sess.id == id);

  if (sessionIndex == -1) {
    savedSessions.push({
      id: id,
      token: token,
      ready: false,
    });
    setSessionsFile(savedSessions);
  }
}

const init = function(socket) {
  const savedSessions = getSessionsFile();

  if (savedSessions.length > 0) {
    if (socket) {
      savedSessions.forEach((e, i, arr) => {
        arr[i].ready = false;
      });

      socket.emit('init', savedSessions);
    } else {
      savedSessions.forEach(sess => {
        createSession(sess.id, sess.token);
      });
    }
  }
}

init();

// Socket IO
io.on('connection', function(socket) {
  init(socket);
});
// Criar sessao
app.post('/criar-sessao', [
    body('id').notEmpty(),
    body('token').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req).formatWith(({
    msg
  }) => {
    return msg;
  });
    if (!errors.isEmpty()) {
      return res.status(422).json({
        status: false,
        message: errors.mapped()
      });
    }
    const id = req.body.id;
    const token = req.body.token;
  try{
    createSession(id,token);
    res.status(200).json({
      status: true,
      message: 'Sessão criada: ' + id + '- Token: ' + token,
      token: token,
      id: id
    })
  } catch(e){
    console.log(e)
    res.status(500).json({
      status: false,
      message: 'A sessão não foi criada.'
    })
  }
});

//Deletar sessão
app.post('/deletar-sessao', [
  body('id').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req).formatWith(({
    msg
  }) => {
    return msg;
  });
  
  if (!errors.isEmpty()) {
    return res.status(422).json({
      status: false,
      message: errors.mapped()
    });
  }
  const id = req.body.id;
  const token = req.body.token;
  const client = sessions.find(sess => sess.id == id).client;
  const savedSessions = getSessionsFile();
  const tokenN = savedSessions.splice(sessionIndex, 1)[0].token;

  if(tokenN !== token){
    res.status(422).json({
      status: false,
      message: 'Token invalido.'
    })
    return;
  }
try {
  fs.rmSync(dirQrcode + '/' + id, {recursive: true, force: true});
  client.destroy();
  client.initialize();
  fs.rmSync ('./.wwebjs_auth/session-' + id, {recursive: true, force: true});
  const savedSessions = getSessionsFile();
  const sessionIndex = savedSessions.findIndex (sess => sess.id == id);
  savedSessions.splice(sessionIndex, 1);
  setSessionsFile(savedSessions);
  res.status (200).json({
    status: true,
    message: 'Sessão deletada: ' + id
  })
} catch (e){
  console.log('Whatsapp App - https://matheusvale.com')
  res.status(500).json({
    status: false,
    message: 'A sessão não foi destruída.'
  })
}
});

// Status de sessao
app.post('/status-sessao', [
  body('id').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req).formatWith(({
    msg
  }) => {
    return msg;
  });

  if (!errors.isEmpty()) {
    return res.status(422).json({
      status: false,
      message: errors.mapped()
    })
  }
const id = req.body.id;
const token = req.body.token;
const client = sessions.find(sess => sess.id == id).client;
const savedSessions = getSessionsFile();
const sessionIndexx = savedSessions.findIndex(sess => sess.id == id);
const tokenN = savedSessions.splice(sessionIndex, 1)[0].token;

if(tokenN !== token){
  res.status(422).json({
    status: false,
    message: 'Token invalido.'
  })
  return;
}
try{
  const status = await client.getState();
  res.status(200).json({
    status: true,
    message: 'Status: ' + status
  })
} catch(e){
  console.log('Aplicação status')
  res.status(500).json({
    status: false,
    message: 'Sessão não encontrada'
  })
}
});

// Send message
app.post('/send-message', [
  body('number').notEmpty(),
  body('message').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req).formatWith(({
    msg
  }) => {
    return msg;
  });
  if (!errors.isEmpty()) {
    return res.status(422).json({
      status: false,
      messagE: errors.mapped()
    });
  }

  console.log(req);

  const sender = req.body.sender;
  const number = phoneNumberFormatter(req.body.number);
  const message = req.body.message;

  const client = sessions.find(sess => sess.id == sender).client;

  // Make sure the sender is exists & ready
  if (!client) {
    return res.status(422).json({
      status: false,
      message: `The sender: ${sender} is not found!`
    })
  }

  const token = req.body.token;
  const savedSessions = getSessionsFile();
  const sessionIndex = savedSessions.findIndex(sess => sess.id == sender);
  const tokenN = savedSessions.splice(sessionIndex, 1)[0].token;
  if(tokenN !== token){
    res.status(422).json({
      status: false,
      message: 'Token inválido'
    })
    return;
  }

  const isRegisteredNumber = await client.isRegisteredUser(number);

  if (!isRegisteredNumber) {
    return res.status(422).json({
      status: false,
      message: 'The number is not registered'
    });
  }

  client.sendMessage(number, message).then(response => {
    res.status(200).json({
      status: true,
      message: 'Mensagem enviada!',
      response: response
    });
  }).catch(err => {
    res.status(500).json({
      status: false,
      message: 'Mensagem não enviada!',
      response: err
    });
  });
});

server.listen(port, function() {
  console.log('App running on *: ' + port);
});
