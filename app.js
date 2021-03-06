const { Client } = require('whatsapp-web.js');
const fs = require('fs');
const util = require('util');
const express = require('express');
const RouteMain = require('./src/http/route-main');
const QRCode = require('qrcode');
const bodyParser = require('body-parser');
const cfg = require('./src/lib/constant');

const app = express();
const port = process.env.PORT || 3000;
const host = process.env.HOST || "0.0.0.0";

app.use(function(req, res, next) {
   res.header("Access-Control-Allow-Origin", "*");
   res.header('Access-Control-Allow-Methods', 'DELETE, PUT');
   res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
   if ('OPTIONS' == req.method) {
      res.sendStatus(200);
    }
    else {
      next();
    }
});

app.use(bodyParser.json());       // to support JSON-encoded bodies
app.use(bodyParser.urlencoded({     // to support URL-encoded bodies
    extended: true
}));

var ConnectedClient = [],
    StreamQRList = [],
    ReadyClientList = [];

const routeMain = new RouteMain();
routeMain.setBotClient(ConnectedClient);
routeMain.setQRModule(QRCode);

app.get('/api/registration', async function (req, res) {
    var querySTR = req.query;
    if (typeof querySTR.phone == 'undefined') {
        res.setHeader('Content-Type', 'Application/Json');
        res.send(JSON.stringify({
            info: false,
            status_code: cfg.status_code.MISSING_REQUIRED_ARGS,
            status: 'Phone number is required to registration.'
        }));

        return;
    }

    var USER_ID = generateID(querySTR.phone);
    if (typeof ConnectedClient[USER_ID] != 'undefined') {
        res.setHeader('Content-Type', 'Application/Json');
        res.send(JSON.stringify({
            info: false,
            status_code: cfg.status_code.CLIENT_IS_REGISTERED,
            status: 'Client is already registered.'
        }));

        return;
    }

    console.log('registering new service : ' + querySTR.phone);

    StreamQRList[USER_ID] = null;
    var SESSION_FILE_PATH = './session/botsession-' + USER_ID + '.json';
    let sessionCfg;
    if (fs.existsSync(SESSION_FILE_PATH)) {
        console.log('loading session from storage : ' + querySTR.phone);
        sessionCfg = require(SESSION_FILE_PATH);
    }

    ConnectedClient[USER_ID] = new Client({ puppeteer: { headless: true, args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process', // <- this one doesn't works in Windows
          '--disable-gpu'] }, session: sessionCfg });
    ConnectedClient[USER_ID].on('disconnected', (reason) => {
        if (fs.existsSync(SESSION_FILE_PATH)) {
            // remove current session file
            fs.unlinkSync(SESSION_FILE_PATH);
            sessionCfg = null;
        }

        ReadyClientList = ReadyClientList.splice(USER_ID);
        routeMain.isClientReady(ReadyClientList);

        // delete from connected list
        removeClient(USER_ID);
        routeMain.setBotClient(ConnectedClient);

        //destroy client instance
        ConnectedClient[USER_ID].destroy().then(function () {
            console.log(ConnectedClient[USER_ID]);
            console.log('Client is shutdown..');
        });
    });

    ConnectedClient[USER_ID].on('authenticated', (session) => {
        console.log('login sucess..');
        sessionCfg = session;
        fs.writeFile(SESSION_FILE_PATH, JSON.stringify(session), function (err) {
            if (err) {
                console.error(err);
            }
        });
    });

    ConnectedClient[USER_ID].on('auth_failure', msg => {
        // Fired if session restore was unsuccessfull
        console.error('AUTHENTICATION FAILURE', msg);

        // remove current session file
        fs.unlinkSync(SESSION_FILE_PATH);
        sessionCfg = null;

        //destroy client instant
        ConnectedClient[USER_ID].destroy().then(function () {
            console.log('Client is shutdown..');

            // delete from connected list
            removeClient(USER_ID);
            routeMain.setBotClient(ConnectedClient);
        });
    });

    ConnectedClient[USER_ID].on('qr', (qr) => {
        // Generate and scan this code with your phone
        StreamQRList[USER_ID] = qr;
        routeMain.setQRCode(StreamQRList);
        console.log("qrcode is ready..");
    });

    ConnectedClient[USER_ID].on('ready', () => {
        StreamQRList[USER_ID] = false;
        routeMain.setQRCode(StreamQRList);

        ReadyClientList[USER_ID] = true;
        routeMain.isClientReady(ReadyClientList);
        console.log('Client is ready..');
    });

    ConnectedClient[USER_ID].on('message', async msg => {
        console.log(util.format("incoming message from %s : %s", msg.from, msg.body));
        if (msg.body == '!ping') {
            const chat = await msg.getChat();
            chat.sendStateTyping();
            client.sendMessage(msg.from, 'pong');
            chat.clearState();
        }
    });

    //start whatsapp client engine
    console.log('initializing');
    var registeringOK = false;
    var message = "Registration Success";
    try {
        await ConnectedClient[USER_ID].initialize();
        registeringOK = true;
    } catch (error) {
        message = "Unable to register client, failed to connect to the host.";
    }

    if (registeringOK) {
        //update botclient object
        routeMain.setBotClient(ConnectedClient);
    } else {
        removeClient(USER_ID);
    }

    res.setHeader('Content-Type', 'Application/Json');
    res.send(JSON.stringify({
        info: registeringOK,
        status: message
    }));
});

//define route request
//send text message, media message, see: https://github.com/barokurniawan/wabot-service/blob/master/README.md
app.get('/api/message', routeMain.handleIndex.bind(routeMain));
app.post('/api/message', routeMain.handleIndex.bind(routeMain));

//get client device information
app.get('/api/device', routeMain.handleDevice.bind(routeMain));
app.post('/api/device', routeMain.handleDevice.bind(routeMain));

//get qrcode
app.get('/api/qr', routeMain.handleScanner.bind(routeMain));

//reset will remove session so we need to scan new qrcode
//reset will make some downtime
app.post('/api/device/reset', function (req, res) {

    StreamQRList[USER_ID] = null;

     var querySTR = req.query;
    if (typeof querySTR.phone == 'undefined') {
        res.setHeader('Content-Type', 'Application/Json');
        res.send(JSON.stringify({
            info: false,
            status_code: cfg.status_code.MISSING_REQUIRED_ARGS,
            status: 'Phone number is required to registration.'
        }));

        return;
    }

    var USER_ID = generateID(querySTR.phone);
    var SESSION_FILE_PATH = './session/botsession-' + USER_ID + '.json';

    if (fs.existsSync(SESSION_FILE_PATH) == false || routeMain.clientReady == false) {
        res.setHeader('Content-Type', 'Application/Json');
        res.send(JSON.stringify({
            info: false,
            status: 'Reset a non ready client is illegal.'
        }));

        return;
    }

    console.log('Shuting down the client..');
    // remove current session file
    fs.unlinkSync(SESSION_FILE_PATH);
    sessionCfg = null;

    //the best solution for reseting client is reset the container it self
    process.exit(1);
});

//use this endpoint to check server status after reseting
app.get('/api/health', function (req, res) {
    res.setHeader('Content-Type', 'Application/Json');
    res.send(JSON.stringify({
        info: true,
        status: 'server is up'
    }));
});

app.get('/api/list-user', function (req, res) {
    res.setHeader('Content-Type', 'Application/Json');
    res.send(JSON.stringify({
        info: true,
        data: extractClient(ConnectedClient)
    }));
});

app.get('/', function (req, res) {
    res.sendFile('index.html', {root: __dirname});
});

function generateID(phone) {
    return phone + "@c.us";
}

function extractClient(ConnectedClient) {
    var o = [];
    for (k in ConnectedClient) {
        o.push(k);
    }

    return o;
}

function removeClient(USER_ID) {
    delete ConnectedClient[USER_ID];
}

//start http server, this server is only visible between container
//not visible to outside, use interface to get access to the engine
app.listen(port, host, () => console.log(`listening at http://${host}:${port}`));
