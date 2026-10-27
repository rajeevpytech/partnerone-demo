'use strict';
const {createApplication}=require('./app');
const app=createApplication();
const args=process.argv.slice(2);
const option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const port=Number(option('--port')||process.env.PORT||3000);
const host=option('--host')||process.env.HOST||'0.0.0.0';
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT must be 1–65535.');
app.server.listen(port,host,()=>console.log(JSON.stringify({level:'info',event:'server_started',port,production:process.env.NODE_ENV==='production'})));
function shutdown(){app.server.close(()=>{app.db.close();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
