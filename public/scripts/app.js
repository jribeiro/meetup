(function() {
	console.log(config.port);
	console.log(config.address);
	var socket = new io.Socket(config.address, {port: config.port, rememberTransport: false}); 
	console.log(socket);
	socket.connect();
	console.log("11111111111111111111111111111111111111111111");
	socket.on('connect', function() {
		console.log("221321312");
		socket.send({ event: 'initial' });
		
	});
	
	socket.on('debug', function(value) {
		  console.log( value);
    });
	
	

	

	

})();