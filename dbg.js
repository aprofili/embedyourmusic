const fs=require("fs");const {JSDOM}=require("jsdom");
const dom=new JSDOM("<body></body>",{runScripts:"outside-only"});const w=dom.window;
w.eval(fs.readFileSync("spengine.js","utf8"));
const eng=w.__eymSpEngine.create(w.document.body,()=>{});
w.addEventListener("message",(e)=>console.log("got",e.origin,e.source===eng.frame.contentWindow, e.source));
w.dispatchEvent(new w.MessageEvent("message",{data:{},origin:"https://open.spotify.com",source:eng.frame.contentWindow}));
