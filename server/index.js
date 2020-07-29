const http = require("http")
const path = require("path")
const fse = require("fs-extra")
const multiparty = require("multiparty")

let test = 0

function deleteFolderRecursive(url) {
  var files = [];
  if (fse.existsSync(url)) {
      files = fse.readdirSync(url);
      files.forEach(function (file, index) {
          var curPath = path.join(url, file);
          if (fse.statSync(curPath).isDirectory()) { // recurse
              deleteFolderRecursive(curPath);
          } else {
              fse.unlinkSync(curPath);
          }
      });
      fse.rmdirSync(url);
  } else {
      console.log("给定的路径不存在，请给出正确的路径");
  }
}

const server = http.createServer()
const UPLOAD_DIR = path.resolve(__dirname, "..", "target")
if (fse.existsSync(UPLOAD_DIR)) {
  deleteFolderRecursive(UPLOAD_DIR)
}

const resolvePost = req => {
  return new Promise((res, rej) => {
    let chunk = ''
    req.on('data', data => {
      chunk += data
    })
    req.on('end', () => {
      res(JSON.parse(chunk))
    })
    req.on('error', e => {
      rej(e)
    })
  })
}

const mergeFileChunk = async (filePath, filename, size, fileType) => {
  let isArr = Object.prototype.toString.call(size) === '[object Array]'
  const chunkPaths = await fse.readdir(filePath)
  chunkPaths.sort((a, b) => a.slice(a.lastIndexOf('-') + 1, a.length) - b.slice(b.lastIndexOf('-') + 1, b.length))
  await Promise.all(
    chunkPaths.map((chunkPath, index) => 
      pipeStream(
        path.resolve(filePath, chunkPath),
        fse.createWriteStream(
          path.resolve(UPLOAD_DIR, filename + '.' + fileType),
          {
            start: isArr ? size[index] : index * size,
            end: isArr ? size[index + 1] : (index + 1) * size
          }  
        )
      )
    )
  )
}

const pipeStream = (path, writeStream) => {
  return new Promise(res => {
    const readStream = fse.createReadStream(path)
    readStream.on('end', () => {
      res()
    })
    readStream.pipe(writeStream)
  })
}

const extractExt = filename => {
  return filename.slice(filename.lastIndexOf("."), filename.length)
}

const createUploadedList = async fileHash => {
  return fse.existsSync(path.resolve(UPLOAD_DIR, fileHash)) ? await fse.readdir(path.resolve(UPLOAD_DIR, fileHash)) : []
}

server.on("request", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Headers", "*")
  if (req.method === "OPTIONS") {
    res.status = 200
    res.end()
    return
  }
  
  if (req.url === '/upload') {
    if(Math.random() < 0.5){
      // 概率报错
      console.log('概率报错了')
      res.statusCode = 500
      res.end(JSON.stringify({
        code: 1,
        message: '略略略，报错了~'
      }))
      return
    }
    const multipart = new multiparty.Form()
    // 拿不到解析的fields 和 files，待解决
    multipart.parse(req, async (err, fields, files) => {
      if (err) {
        console.log(err)
        return
      }
      let chunk = ''
      let hash = ''
      let filename = ''
      let chunkDir = ''
      multipart.on('file', (name ,val) => {
        if (name === 'chunk') {
          chunk = val
        }
      })
      multipart.on('field', async (name ,val) => {
        if (name === 'hash') {
          hash = val
          chunkDir = path.resolve(UPLOAD_DIR, hash)
          if (!fse.existsSync(chunkDir)) { // 是否存在目录
            await fse.mkdirs(chunkDir)
          }
        }
        if (name === 'filename') {
          console.log('filename', val)
          filename = val
          await fse.move(chunk.path, `${chunkDir}/${filename}`)
          res.end(JSON.stringify({
            code: 0,
            message: "received file chunk"
          }))
        }
      })
    })
  }
  // 是否需要给每个chunk 提供size, 待验证
  if (req.url === '/merge') {
    const { filename:fileFullname, hash, size } = await resolvePost(req)
    const fileType = fileFullname.slice(fileFullname.lastIndexOf('.') + 1, fileFullname.length)
    const filePath = path.resolve(UPLOAD_DIR, hash)
    mergeFileChunk(filePath, hash, size, fileType)
    res.end(JSON.stringify({
      code: 0,
      message: "file merged success"
    }))
  }
  
  if (req.url === '/verify') {
    const data = await resolvePost(req)
    const { fileHash, filename } = data
    const ext = extractExt(filename)
    const filePath = path.resolve(UPLOAD_DIR, fileHash+ext)
    if (fse.existsSync(filePath)) {
      res.end(
        JSON.stringify({ shouldUpload: false })
      )
    } else {
      res.end(
        JSON.stringify({ 
          shouldUpload: true,
          uploadedList: await createUploadedList(fileHash)
        })
      )
    }
  }
})



server.listen(3000, () => console.log("正在监听 3000 端口"))
