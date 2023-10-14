const express = require("express");
const multer = require("multer");
const path = require("path");
const helpers = require('./helpers');
const app = express();
const http = require('http');
const https = require('https');
const fs = require('fs');
const { auth, requiresAuth } = require('express-openid-connect');
const bodyParser = require('body-parser')
const { nanoid } = require('nanoid')

require('dotenv').config()

const config = {
    authRequired: false,
    auth0Logout: true,
    secret: process.env.SECRET || throwError("SECRET"),
    baseURL: process.env.BASE_URL || throwError("BASE_URL"),
    clientID: process.env.CLIENT_ID || throwError("CLIENT_ID"),
    issuerBaseURL: process.env.ISSUER_BASE_URL || throwError("ISSUER_BASE_URL")
};

const allowedUserEmails = process.env.ALLOWED_USERS || throwError("ALLOWED_USERS");

function throwError(variableName) {
    throw new Error(`Missing environment variable: ${variableName}`);
}

let devEnv = false;
let credentials;

try {
    let privateKey  = fs.readFileSync(path.join(__dirname, 'cert/server.key'), 'utf8');
    let certificate = fs.readFileSync(path.join(__dirname, 'cert/server.crt'), 'utf8');
    credentials = {key: privateKey, cert: certificate};
}
catch {
    console.log("Credentials not found. Running development environment.");
    devEnv = true;
}

app.use(auth(config));
app.use(express.static(path.join(__dirname, 'public')))
app.use(express.static(path.join(__dirname, 'uploads')))
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');
app.use(bodyParser.urlencoded({ extended: false }))
app.use(bodyParser.json())

let httpServer;
let httpsServer;

if (devEnv) {
    console.log("Server running as HTTP");
    httpServer = http.createServer(app);
    httpServer.listen(80);
}
else {
    console.log("Server running as HTTPS");
    httpsServer = https.createServer(credentials, app);
    httpsServer.listen(443)
}

app.get('/profile', requiresAuth(), (req, res) => {
    res.send(JSON.stringify(req.oidc.user));
});

app.get("/", (req, res, next) => {
    res.render('index')
})

app.get("/upload", (req, res, next) => {
    res.render('upload')
})

app.get("/admin", async (req, res, next) => {
    if (req.oidc.isAuthenticated() && allowedUserEmails.includes(req.oidc.user.email)) {
        const uploadsDirectory = path.join(__dirname, '/uploads');
        const uploads = fs.readdirSync(uploadsDirectory);
        
        let uploadsData = {};
        for (let fileName of uploads) {
            const filePath = path.join(uploadsDirectory, fileName);
            const fileStats = fs.statSync(filePath);
            uploadsData[fileName] = fileStats.birthtime;  // or use `fileStats.mtime` for modification time
        }

        res.render('admin', { user: req.oidc.user, uploads: uploads, uploadsData: JSON.stringify(uploadsData) });
    } else {
        res.redirect('/login');
    }
});


app.post("/delete", async (req, res, next) => {
    if (req.oidc.isAuthenticated() && allowedUserEmails.includes(req.oidc.user.email)) {
        const imageUrl = req.body.url; // The client should send the image URL (or filename) to be deleted in the body of the request
        if (!imageUrl) {
            return res.status(400).send("URL required"); 
        }
        try {
            const imagePath = path.join(__dirname, '/uploads', imageUrl);
            
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
                return res.sendStatus(200);
            } else {
                return res.status(404).send("Image not found"); 
            }
        } catch (e) {
            console.log(e);
            return res.sendStatus(400);
        }
    } else {
        return res.sendStatus(401);
    }
});


app.post("/upload", (req, res) => {
    let upload = multer({ storage: storage, fileFilter: helpers.imageFilter }).single('file-uploaded');
    upload(req, res, function(err) {
        // req.file contains information of uploaded file
        // req.body contains information of text fields, if there were any

        if (req.fileValidationError) {
            return res.send(req.fileValidationError);
        }
        else if (!req.file) {
            return res.send('Please select an image to upload');
        }
        else if (err instanceof multer.MulterError) {
            return res.send(err);
        }
        else if (err) {
            return res.send(err);
        }
        // Display uploaded image for user validation
        res.redirect(`${req.file.filename}`)
    });
});

const storage = multer.diskStorage({
    destination: function(req, file, cb) {
        cb(null, 'uploads/');
    },

    // By default, multer removes file extensions so let's add them back
    filename: function(req, file, cb) {
        cb(null, nanoid(10) + path.extname(file.originalname));
    }
});