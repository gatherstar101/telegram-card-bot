import net from 'node:net';

export async function testMailer(mail) {
  const sockets=new Set();
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
    let buffer='';let data=false;let message='';
    socket.write('220 localhost test SMTP\r\n');
    socket.on('data',chunk=>{
      buffer+=chunk.toString();
      while(buffer.includes('\r\n')) {
        const end=buffer.indexOf('\r\n');const line=buffer.slice(0,end);buffer=buffer.slice(end+2);
        if(data){
          if(line==='.') {
            data=false;
            const [headers,...parts]=message.split('\r\n\r\n');
            const raw=parts.join('\r\n\r\n');
            const body=/Content-Transfer-Encoding: base64/i.test(headers)?Buffer.from(raw.replace(/\s/g,''),'base64').toString():raw.replace(/=\r\n/g,'');
            mail.push({code:body.match(/(?<!\d)\d{6}(?!\d)/)?.[0]});message='';socket.write('250 accepted\r\n');
          }
          else message+=line+'\r\n';
        } else if(/^DATA$/i.test(line)){data=true;socket.write('354 send message\r\n');}
        else if(/^QUIT$/i.test(line))socket.end('221 goodbye\r\n');
        else socket.write('250 localhost\r\n');
      }
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {port:server.address().port,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
