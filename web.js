require.paths.unshift(__dirname + '/lib');

var everyauth = require('everyauth');
var express   = require('express');
var FacebookClient = require('facebook-client').FacebookClient;
var facebook = new FacebookClient();

var RedisStore = require('connect-redis')(express);

var uuid = require('node-uuid');


/***** PREPARED QUERIES *****/
var pg = require('pg');
var connectionString = process.env.DATABASE_URL || 'postgres://meetup:meetup@localhost/meetup';



/****************************/

/*** LIB MODULES **/
var get_ip = require('get_ip');

var logged_users = [];

// configure facebook authentication
everyauth.facebook
  .appId(process.env.FACEBOOK_APP_ID  || 'APP_ID' )
  .appSecret(process.env.FACEBOOK_SECRET || 'APP_SECRET')
  .scope('user_likes,user_photos,user_photo_video_tags,email,user_birthday,user_location,user_work_history,user_likes,user_relationships')
  .entryPath('/')
  .redirectPath('/home')
  .findOrCreateUser(function() {

      // TODO
    return({});
  });

// create an express webserver
var app = express.createServer(
  express.logger(),
  express.static(__dirname + '/public'),
  express.cookieParser(),
  // set this to a secret value to encrypt session cookies
  express.session({ secret: process.env.SESSION_SECRET || 'secret123', store: new RedisStore}),
  // insert a middleware to set the facebook redirect hostname to http/https dynamically
  function(request, response, next) {
    var method = request.headers['x-forwarded-proto'] || 'http';
    everyauth.facebook.myHostname(method + '://' + request.headers.host);

    next();
  },
  everyauth.middleware(),
  require('facebook').Facebook()
);

//figuring out which addresses we should use (for the express server, and for REDIS)
var addressToUse = null;
var redisServerAddressToUse = null;
if (process.env.NODE_ENV === undefined || process.env.NODE_ENV !== 'production')
{
	addressToUse = process.env.MEETUP_HOST || 'localhost';
	redisServerAddressToUse = process.env.MEETUP_HOST_REDIS || 'localhost';
}
else {
	addressToUse = 'meetup-io.heroku.com';
	redisServerAddressToUse = '127.0.0.1';
}

console.log('Using address: ' + addressToUse);
console.log('Using redis server address: ' + redisServerAddressToUse);

// listen to the PORT given to us in the environment
var port = process.env.PORT || 3000;
app.configure('development', function() {
	app.set('port', port);
	app.set('address', addressToUse);
	  app.use(express.errorHandler({
		  dumpExceptions: true,
		  showStack: true
	  }));
});


app.configure('production', function() {
	app.set('port', 80);
    app.set('address', addressToUse);
	app.use(express.errorHandler());
});

app.listen(port, function() {
  console.log("Listening on " + port);
 // console.log(app);
});

  //Call to postgres db

var start = new Date();
var pgClient = new pg.Client(connectionString);
// Connect to DB
pgClient.connect();


var async = require('async');

// create a socket.io backend for sending facebook graph data
// to the browser as we receive it
var io = require('socket.io').listen(app);

// wrap socket.io with basic identification and message queueing
// code is in lib/socket_manager.js
var socket_manager = require('socket_manager').create(io);

var redisSocketIO = require('socket.io/node_modules/redis');

var pub = redisSocketIO.createClient('6379', redisServerAddressToUse);
var sub = redisSocketIO.createClient('6379', redisServerAddressToUse);
var store = redisSocketIO.createClient('6379', redisServerAddressToUse);

//pub.auth('pass', function(){console.log("adentro! pub")});
//sub.auth('pass', function(){console.log("adentro! sub")});
//store.auth('pass', function(){console.log("adentro! store")});

// use xhr-polling as the transport for socket.io and RedisStore to store data
io.configure(function () {
  io.set("transports", ["xhr-polling"]);
  io.set("polling duration", 10);
  var RedisStoreSocketIO = require('socket.io/lib/stores/redis');
	io.set('store', new RedisStoreSocketIO({redisPub:pub, redisSub:sub, redisClient:store}));
});

/*
 * . Send the user-details through the socket_id
 * . Update through PostGres the indication that the given user is active
 * . And if he doesn't exist, add him to the table
 */
function fetchAndProcessMeGraphCall(session /*a FacebookSession*/, socket_id, ip)
{
	 // query User info and try to insert into DB
     session.graphCall('/me&date_format=Y-m-d%20G:i:s')(function(result) {
       socket_manager.send(socket_id, 'user-details', result);
        // debug(socket_id,"graph call /me: ",result);
       id = result.id;

       pgClient.query({
           text: "update users set is_active = 1, ip = $1 where id=$2",
			values: [ip,id]
       }, function(u_err, u_result){
           //	debug(socket_id,"update errors: ",u_err);
           //	debug(socket_id,"update result: ",u_result);
           var date_now = new Date();

           var month = date_now.getMonth() + 1;
           var gender;
           if(u_result.rowCount === 0){
               if(result.gender=='male')
                   gender='m';
               else
                   gender='f';
               var date_created = date_now.getFullYear() + "-" + month + "-" + date_now.getDate() + " " + date_now.getHours() + ":" + date_now.getMinutes() + ":" + date_now.getSeconds();
               // Welcome user!! First Visit :)
               pgClient.query({
                   text: 'insert into users (id,first_name,last_name,email,gender,is_active,ip,date_joined) values' +
                   '($1,$2,$3,$4,$5,$6,$7,$8)',
                   values: [result.id,result.first_name,result.last_name,result.email,gender,1,ip,date_created]
               }, function(i_err, i_result){
                   // debug(socket_id,"insert errors: ",i_err);
                   // debug(socket_id,"insert result: ",i_result);
                   if(!i_err){
                       // YEY ONE MORE USER!! WE MIGHT SEND A GRRETING CARD :P
                       //push to online users
                       //logged_users.push(id);
                   }
               });
			}
           else{
               //push to online users
              // logged_users.push(id);
			}
       });
     });
}

function fetchAndProcessLikesGraphCall(session /*FacebookSession*/)
{
	 /**** LIKES ****/
     session.graphCall('/me/likes&date_format=Y-m-d%20G:i:s')(function(result) {
        // debug(socket_id,"graph call /likes: ",result);
       var new_likes = 0;
       result.data.map(function(like) {
           return 	pgClient.query({
               text: 'insert into likes(fb_id, name, category) values' +
                       '($1, $2, $3)',
               values: [like.id, like.name, like.category]
           }, function (err, res){
                   if(!err){
                       new_likes ++;
                   }
                 /*  var query1 = client.query("SELECT * FROM users ");
   				//can stream row results back 1 at a time
   				query1.on('row', function(row) {
		    		  //console.log(row);

                   });*/
                   pgClient.query({
                       text: 'insert into likes_rel(user_id, likes_id, created_at) values' +
                               '($1, $2, $3)',
                       values: [id, like.id, like.created_time]
                       }, function (err, res){
                               //console.log(1);
                           }
                       );
   			});
       	  }).pop().on('end', function(){
       	   // console.log("User has %s likes -----> %s new likes inserted in main table", user_likes, new_likes);
       	    //client.end();
   	  });
     });
	
}

/*
 * TODO: not sure if this is useful, and not sure if questioning the Graph is better than the PostgreSQL. 
 * Also, friends in common would be more interesting
 * 
 */
function fetch4FriendsAndSendThroughSocket(session /*FacebookSession */, socket_id) {
	// query 4 friends and send them to the socket for this socket id
    session.graphCall('/me/friends&limit=4')(function(result) {
      result.data.forEach(function(friend) {
        socket_manager.send(socket_id, 'friend', friend);
      });
    });
}

function fetch4LikesAndSendThroughSocket(session /*FacebookSession */, socket_id)
{
	  // query 4 likes and send them to the socket for this socket id
      session.graphCall('/me/likes&limit=4')(function(result) {
        result.data.forEach(function(like) {
          socket_manager.send(socket_id, 'like', like);
        });
      });
}

function fetchBasicFBAppInfoAndRenderHomePage(session /*FacebookSession*/, app /*Express app */, request, response, token, socket_id)
{
	
	  var method = request.headers['x-forwarded-proto'] || 'http';
	  session.graphCall('/' + process.env.FACEBOOK_APP_ID)(function(fbApp) {

		  // render the home page
		  response.render('home.ejs', {
			  layout:   false,
			  token:    token,
			  app: fbApp,
			  user:     request.session.auth.facebook.user,
			  home:     method + '://' + request.headers.host + '/',
			  redirect: method + '://' + request.headers.host + request.url,
			  socket_id: socket_id,
			  address: app.settings.address,
			  port: app.settings.port
		  });
	  });
	
}


function routeHome(request, response) 
{
	//fazer ficheiro todas as foreign keys e default values

  // detect the http method uses so we can replicate it on redirects

  // if we have facebook auth credentials
  if (request.session.auth) {

    // initialize facebook-client with the access token to gain access
    // to helper methods for the REST api
    var token = request.session.auth.facebook.accessToken;
    facebook.getSessionByAccessToken(token)(function(session) {

      // generate a uuid for socket association
      var socket_id = uuid();

      //Get client ip
      var ip = get_ip.getClientIp(request);
      console.log(ip);
      
      
//for now let's use Async, eventually let's use Cluster and/or Kue to make this really 
//work in parallel :) - scalability FTW!
      

      async.parallel([fetchAndProcessMeGraphCall(session, socket_id, ip),
                fetchAndProcessLikesGraphCall(session),
                fetch4FriendsAndSendThroughSocket(session, socket_id),
                fetch4LikesAndSendThroughSocket(session, socket_id),
                fetchBasicFBAppInfoAndRenderHomePage(session, app, request, response, token, socket_id)], function() {
    	  			console.log('** Done processing graph calls and user **');
      			});
      // query 16 photos and send them to the socket for this socket id
    /* session.graphCall('/me/photos&limit=16')(function(result) {
        result.data.forEach(function(photo) {
          socket_manager.send(socket_id, 'photo', photo);
        });
      });*/
  });

  } else {

    // not authenticated, redirect to / for everyauth to begin authentication
    response.redirect('/');

  }
}

// respond to GET /home
app.get('/home', routeHome);

app.post('/', function(request, response) {
  response.redirect('/home');
});



/*
 * Recebe um nome identificativo e o objecto/valor envia para o socket de modo a efectuar o debug
 */

function debug(socket_id,name, value) {
	var vDebug = {
	  type: name,
	  debug_value: value
	}
  socket_manager.send(socket_id, 'debug', vDebug);
};


