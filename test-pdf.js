const fs = require('fs');
const path = require('path');
let pdf = require('pdf-parse');
if (typeof pdf !== 'function' && pdf && typeof pdf.default === 'function') pdf = pdf.default;

const uploadsDir = path.join(__dirname, 'uploads');
const arg = process.argv[2];

function latestUpload() {
  const files = fs.readdirSync(uploadsDir).filter(f => fs.statSync(path.join(uploadsDir,f)).isFile());
  if (files.length === 0) {
    console.error('No files in uploads folder:', uploadsDir);
    process.exit(1);
  }
  files.sort((a,b) => fs.statSync(path.join(uploadsDir,b)).mtime - fs.statSync(path.join(uploadsDir,a)).mtime);
  return path.join(uploadsDir, files[0]);
}

const filePath = arg ? path.resolve(arg) : latestUpload();
console.log('Testing PDF:', filePath);

pdf(fs.readFileSync(filePath))
  .then(r => {
    console.log('OK — extracted text sample (first 500 chars):\n');
    console.log(r.text ? r.text.slice(0,500) : '(no text returned)');
  })
  .catch(e => {
    console.error('PDF parse failed:');
    console.error(e && e.stack ? e.stack : e);
  });