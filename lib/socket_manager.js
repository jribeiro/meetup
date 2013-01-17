var opentok = require('opentok');
//open tok secret
var ot = new opentok.OpenTokSDK('413302', 'fc512f1f3c13e3ec3f590386c986842f92efa7e7');


// Prepare embed.ly
var EMBEDLY_KEY = 'aa941dc2504411e1b4764040d3dc5c07';

var embedly = require('embedly')
  , require_either = embedly.utils.require_either
  , util = require_either('util', 'utils')
  , Api = embedly.Api
  , api = new Api({user_agent: 'Mozilla/5.0 (compatible; meetup/1.0; jribeiro@wedobuzz.com)', key: EMBEDLY_KEY});

// free users array - without chat partner; match queries should pick from this users
/*
 * consider storing this in postgre or redis
 * postgres - + can perform the match with a simple query from algorithym and free users table. simple join does the magic
 * redis - nosql performance
 */
var soloUsers = [];
var SocketManager = function(io) {
        console.log("start sockets");
        this.io = io;
        this.sockets = {};
        this.queues = {};
        var manager = this;
        io.sockets.on('connection', function(socket) {
                    console.log("------------------------------>SOCKET.IO CONNECTION <_------------------------------------------");
            // when a socket sends an auth message, associate it with
            // that socket id
            socket.on('auth', function(socket_id) {
                    console.log("------------------------------> SOCKET.IO Authorization <_------------------------------------------");
                manager.sockets[socket_id] = socket;
                socket.set('socket_id', socket_id, function(err) { console.log('err ' + err + 'socket ' + socket_id+ ' saved')});
                    console.log("------------------------------> SOCKET.IO Authorization 2nd Point <_------------------------------------------");
                console.log("sockets auth: " + socket_id);
            });
            // clean up
            socket.on('disconnect', function() {
                socket.get('socket_id', function(err, socket_id) {
                    delete manager.sockets[socket_id];
                    delete manager.queues[socket_id];
                });
            });
            socket.on('message', function(message, fn) {
                console.log("Socket Received Message: ");
                console.log(message);
                var tokHost = 'meetup-io.heroku.com';
                //var tokHost = '192.168.1.6';
                // Parse the incoming event
                
                switch (message.event) {
                    // User requested initialization data
                case 'initial':
                    console.log("------------------------------> INITIAL <_------------------------------------------");
                    // Create an OpenTok session for each user
                    ot.createSession(tokHost, {}, function(session) {
                        // Each user should be a moderator
                        var data = {
                            sessionId: session.sessionId,
                            token: ot.generateToken({
                                sessionId: session.sessionId,
                                role: opentok.Roles.MODERATOR
                            })
                        };
                        //socket.set('opentok', data);

                        // Send initialization data back to the client
                        socket.emit('message', {
                            event: 'initial',
                            data: data
                        });
                    });
                    break;
                    // User requested next partner
                case 'next':
                    var sid;
                    // AQUI PRECISO DE TER O ID DO MEU SOCKET!!
                    socket.get('socket_id', function(err, socket_id) {
                        sid = socket_id;
                        
                        // Create a "user" data object for me
                        var me = {
                            sessionId: message.data.sessionId,
                            clientId: sid
                        };
                        
                        console.log("----------------------------------> meeee <------------------------------");
                        console.log();
                    
                        console.log(me);
                        tmp_socket = manager.sockets[sid];
                        var partner;
                        var partnerClient;
                        // Look for a user to partner with in the list of solo users
                        
                        for (var i = 0; i < soloUsers.length; i++) {
                            var tmpUser = soloUsers[i];
                            // Make sure our last partner is not our new partner
                            if (tmp_socket.partner != tmpUser && tmp_socket != tmpUser) {
                                // Get the socket client for this user
    
                                //let's try this approach if clientId has auth id for socket we should be very good!
    
                                // In that case we have partnerClient= Socket do parceiro! Um simples partner.emit(message, subscribe) makes us happy
                                partnerClient = manager.sockets[tmpUser.clientId];
                                // Remove the partner we found from the list of solo users
                                soloUsers.splice(i, 1);
                                // If the user we found exists...
                                if (partnerClient) {
                                    // Set as our partner and quit the loop today
                                    partner = tmpUser;
                                    break;
                                }
                            }
                            else{
                                //isto nao devia acontecer na primeira iteração 
                                console.log("failllllllllllllllllllllll");
                            }
                        }
                        
                        // If we found a partner...
                        if (partner) {
                            //socket.emit('debug')
                            
                            //     Tell myself to subscribe to my partner
                            socket.emit('message', {
                                event: 'subscribe',
                                data: {
                                    sessionId: partner.sessionId,
                                    token: ot.generateToken({
                                        sessionId: partner.sessionId,
                                        role: opentok.Roles.SUBSCRIBER
                                    })
                                }
                            });
                            // Tell my partner to subscribe to me
                            partnerClient.emit('message', {
                                event: 'subscribe',
                                data: {
                                    sessionId: me.sessionId,
                                    token: ot.generateToken({
                                        sessionId: me.sessionId,
                                        role: opentok.Roles.SUBSCRIBER
                                    })
                                }
                            });
                            // Mark that my new partner and me are partners
                            tmp_socket.partner = partner;
                            partnerClient.partner = me;
                            // 	Mark that we are not in the list of solo users anymore
                            socket.inList = false;
                            partnerClient.inList = false;
                            //assign a room to be used to chat on
                            
                            //room id = both socket ids plus a random number from 0 to 10000
                            var roomId = partner.sessionId + me.sessionId + "|" + Math.floor((Math.random()*10000)+1);
                            socket.join(roomId);
                            partnerClient.join(roomId);
                            console.log("Generated room ID:"+roomId);
                            //TODO objectify these methodsm very unclean code here
                            socket.set('chatRoomId', roomId, function(){
                            	socket.emit('message', {
                            		event: 'chatStatus',
                            		data: {
                            			status: 'online'
                            	}
                            	})
                            });
                            
                            partnerClient.set('chatRoomId', roomId, function(){
                            	partnerClient.emit('message', {
                            		event: 'chatStatus',
                            		data: {
                            			status: 'online'
                            	}
                            	})
                            });
                        }
                        else {
                            // Delete that I had a partner if I had one
                            if (tmp_socket.partner) {
                                delete tmp_socket.partner;
                            }
                            // Add myself to list of solo users if I'm not in the list
                            if (!socket.inList) {
                                socket.inList = true;
                                soloUsers.push(me);
                            }
                            // Tell myself that there is nobody to chat with right now
                            socket.emit('message', {
                                event: 'empty'
                            });
                            
                            //TODO put this code in a method..
                        	//make you leave the room for chatting if you were in one
                            socket.get('chatRoomId', function(err, chatRoomId)
                            	{
                            		socket.emit('message', {
                            			event: 'chatStatus',
                            			data: {
                            				status:'offline'
                            		}
                            		});
                            		
                            		if (err)
                            			{
                            			//TODO ?
                            			console.log('Error getting chatRoomId. ' + err);
                            			return;
                            			}
                            		socket.leave(chatRoomId);
                            		socket.del('chatRoomId');
                            	});
                        }
                        });

                    break;
                case 'chatMessage':
                	//TODO escaping
                    var expression = /[-a-zA-Z0-9@:%_\+.~#?&//=]{2,256}\.[a-z]{2,4}\b(\/[-a-zA-Z0-9@:%_\+.~#?&//=]*)?/gi;
                    var regex = new RegExp(expression);
                    var msg = message.data.chatMsg;
                    var urlEmbed = msg.match(regex);
                    var urlControl = 0;
                    // ver concorrencia. se  embed demora demasiado tempo a responder o que acontece?

                    if (urlEmbed){
                        // call single url
                        api.oembed({url: urlEmbed[0]}).on('complete', function(objs) {
//                            socket.get('socket_id',function (err, socket_id){
//                                var partner = manager.sockets[socket_id].partner;
//                                var partnerSocket = manager.sockets[partner.clientId];
//                                partnerSocket.emit('message', {
//                                    event: 'chatEmbed',
//                                    data: {
//                                        chatMsg: message.data.chatMsg,
//                                        html: objs[0].html
//                                    }
//                                });
//                            });
//so, we don't need to get the corresponding partner id socket, get the room ID
//TODO make this a function of sorts
                        	socket.get('chatRoomId', function(err,chatRoomId){
                        		socket.broadcast.to(chatRoomId).emit('message',{
                        			event: 'chatEmbed',
                        				data: {
                        					chatMsg: msg
                        			}
                        		});
                        		//TODO make the server send back the OOEmbed, in case it an OOEmbed event.
                        		fn('nothing');
                        	});
                        }).start();
                        
                    }else{
//                        socket.get('socket_id',function (err, socket_id){
//                            var partner = manager.sockets[socket_id].partner;
//                            var partnerSocket = manager.sockets[partner.clientId];
//                            partnerSocket.emit('message', {
//                                event: 'chatMessage',
//                                data: {
//                                    chatMsg: message.data.chatMsg
//                                }
//                            });
//                        });
//so, we don't need to get the corresponding partner id socket, get the room ID
//TODO make this a function of sorts
                        	socket.get('chatRoomId', function(err,chatRoomId){
                        		socket.broadcast.to(chatRoomId).emit('message',{
                        			event: 'chatEmbed',
                        				data: {
                        					chatMsg: msg
                        			}
                        		});
                        		//TODO make the server send back the OOEmbed, in case it an OOEmbed event.
                        		fn('nothing');
                        	});
                    }
                    break;
                }
            });
        });
        // send a message to a socket
        this.send = function(socket_id, topic, message) {
            // build a queue if it doesn't exist
            if (!manager.queues[socket_id]) {
                manager.queues[socket_id] = [];
            }
            // add this message to the socket's queue
            manager.queues[socket_id].push([topic, message]);
        };
        // attempt to send all queued messages to the available sockets
        this.flush = function() {
            for (var socket_id in manager.queues) {
                // if a socket exists for this socket_id
                if (manager.sockets[socket_id]) {
                    // send all outstanding messages to the socket
                    manager.queues[socket_id].forEach(function(item) {
                        manager.sockets[socket_id].emit(item[0], item[1]);
                    });
                    // clear the queue
                    manager.queues[socket_id] = [];
                }
            };
        };
        // attempt to flush the socket queues every 1000ms
        setInterval(this.flush, 1000);
    };
module.exports.create = function(io) {
    return new SocketManager(io);
}