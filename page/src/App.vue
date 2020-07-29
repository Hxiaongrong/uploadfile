<template>
  <div id="app">
    <input type="file" @change="handleFileChange">
    <el-button @click="handleUpload">上传</el-button>
    <p>计算hash进度</p>
    <el-progress :text-inside="true" :stroke-width="26" :percentage="percentage" />
    <p>总进度</p>
    <el-progress :text-inside="true" :stroke-width="26" :percentage="uploadPercentage" />

    <el-table :data="data">
      <el-table-column label="切片hash" prop="hash" />
      <el-table-column label="大小" prop="size" />
      <el-table-column label="进度">
        <template slot-scope="scope">
          <el-progress :text-inside="true" :stroke-width="26" :percentage="scope.row.percentage" />
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script>
import SparkMD5 from 'spark-md5'
const SIZE = 10 * 1024 * 1024 // 切片大小
export default {
  data: () => ({
    container: {
      file: null,
      hash: ''
    },
    data: [],
    percentage: 0
  }),
  computed: {
    uploadPercentage() {
      if (!this.container.file || !this.data.length) return 0
      const loaded = this.data
        .map(item => item.size * item.percentage)
        .reduce((acc, cur) => acc + cur)
      return parseInt((loaded / this.container.file.size).toFixed(2))
    }
  },
  methods: {
    handleFileChange(e) {
      const [file] = e.target.files
      if (!file) return
      this.container.file = file
    },
    calculateHash(fileChunkList) {
      return new Promise(res => {
        const spark = new SparkMD5.ArrayBuffer()
        let count = 0
        const loadNext = index => {
          const reader = new FileReader()
          reader.onload = e => {
            count++
            spark.append(e.target.result)
            if (count === fileChunkList.length) {
              res(spark.end())
              this.percentage = 100
            } else {
              this.percentage += 100 / fileChunkList.length
              loadNext(count)
            }
          }
          reader.readAsArrayBuffer(fileChunkList[index].file)
        }
        loadNext(0)
      })
    },
    async calculateHashIdle(chunks) {
      return new Promise(res => {
        const spark = new SparkMD5.ArrayBuffer()
        let count = 0
        const appendToSpark = async file => {
          return new Promise(resolve => {
            const reader = new FileReader()
            reader.onload = e => {
              spark.append(e.target.result)
              resolve()
            }
            reader.readAsArrayBuffer(file)
          })
        }
        const workLoop = async deadline => {
          while (count < chunks.length && deadline.timeRemaining() > 1) {
            await appendToSpark(chunks[count].file)
            count++
            if (count < chunks.length) {
              this.percentage = Number(((100 * count) / chunks.length).toFixed(2))
            } else {
              this.percentage = 100
              res(spark.end())
            }
          }
          window.requestIdleCallback(workLoop)
        }
        window.requestIdleCallback(workLoop)
      })
    },
    async calculateHashSample() {
      return new Promise(res => {
        const spark = new SparkMD5.ArrayBuffer()
        const reader = new FileReader()
        const file = this.container.file
        const size = this.container.file.size
        const offset = 2 * 1024 * 1024
        const chunks = [file.slice(0, offset)]

        let cur = offset
        while (cur < size) {
          this.percentage = +(parseFloat(cur / size * 100).toFixed(2))
          if (cur + offset >= size) {
            chunks.push(file.slice(cur, cur + offset))
          } else {
            const mid = cur + offset / 2
            const end = cur + offset
            chunks.push(file.slice(cur, cur + 2))
            chunks.push(file.slice(mid, mid + 2))
            chunks.push(file.slice(end - 2, end))
          }
          cur += offset
        }
        reader.onload = e => {
          spark.append(e.target.result)
          this.percentage = 100
          res(spark.end())
        }
        reader.readAsArrayBuffer(new Blob(chunks))
      })
    },
    createProgressHandler(item) {
      return e => {
        item.percentage = parseInt(String((e.loaded / e.total) * 100))
      }
    },
    createFileChunk(file, size = SIZE) {
      const chunks = []
      let cur = 0
      while (cur < file.size) {
        chunks.push({ file: file.slice(cur, cur + size) })
        cur += size
      }
      return chunks
    },
    async handleUpload() {
      if (!this.container.file) return
      const fileChunkList = this.createFileChunk(this.container.file)
      // this.container.hash = await this.calculateHash(fileChunkList)
      // this.container.hash = await this.calculateHashIdle(fileChunkList) // 利用帧之间的时间切片空闲时间
      this.container.hash = await this.calculateHashSample(fileChunkList) // 抽样切片
      const { shouldUpload } = await this.verifyUpload(
        this.container.file.name,
        this.container.hash
      )
      if (!shouldUpload) {
        this.$message.success('秒传：上传成功')
        return
      }
      this.data = fileChunkList.map(({ file }, index) => ({
        fileHash: this.container.hash,
        chunk: file,
        size: file.size,
        hash: this.container.file.name + '_' + this.container.hash + '-' + index,
        percentage: 0,
        index
      }))
      await this.uploadChunks()
    },
    async slowUpload() {
      const file = this.container.file
      if (!file) return
      const fileSize = file.size
      let offset = 1024 * 1024
      let cur = 0
      let count = 0
      this.container.hash = await this.calculateHashSample()
      this.data = []
      const { shouldUpload } = await this.verifyUpload(
        this.container.file.name,
        this.container.hash
      )
      if (!shouldUpload) {
        this.$message.success('秒传：上传成功')
        return
      }

      while (cur < fileSize) {
        const chunk = file.slice(cur, cur + offset)
        cur += offset
        const filename = this.container.file.name + '_' + this.container.hash + '-' + count
        this.data.push({
          hash: filename,
          size: chunk.size,
          percentage: 0
        })
        const form = new FormData()

        form.append('chunk', chunk)
        form.append('hash', this.container.hash)
        form.append('filename', filename)
        form.append('size', chunk.size)
        const start = new Date().getTime()
        await this.request({ url: 'http://localhost:3000/upload', data: form, onProgress: this.createProgressHandler(this.data[count]) })
        const now = new Date().getTime()
        const time = ((now - start) / 1000).toFixed(4)
        let rate = time / 0.1
        console.log(`切片${count}大小是${offset},耗时${time}秒，是0.1秒的${rate}倍，修正大小为${parseInt(offset / rate)}`)
        if (rate < 0.5) rate = 0.5
        if (rate > 2) rate = 2
        offset = parseInt(offset / rate)
        count++
      }
      await this.mergeRequest()
    },
    async verifyUpload(filename, fileHash) {
      const { data } = await this.request({
        url: 'http://localhost:3000/verify',
        headers: {
          'content-type': 'application/json'
        },
        data: JSON.stringify({
          filename, fileHash
        })
      })
      return JSON.parse(data)
    },
    async uploadChunks() {
      const requestList = this.data
        .map(({ chunk, hash, index, fileHash }) => {
          const formData = new FormData()
          formData.append('chunk', chunk)
          formData.append('hash', fileHash)
          formData.append('filename', hash)
          return { formData, index, status: 'wait' }
        })
        // 不能很好的处理并发
        // .map(({ formData, index }) => this.request({
        //   url: 'http://localhost:3000/upload',
        //   data: formData,
        //   onProgress: this.createProgressHandler(this.data[index])
        // }))
      // const res = await Promise.all(requestList)
      const res = await this.sendRequest(requestList, 4)
      console.log(res)
      await this.mergeRequest()
    },
    async sendRequest(forms, max = 4) {
      const retryTime = 3
      return new Promise((res, rej) => {
        const len = forms.length
        let counter = 0
        const retryArr = forms.map(item => 0)
        const start = async() => {
          while (counter < len && max > 0) {
            const idx = forms.findIndex(item => {
              return item.status === 'wait' || item.status === 'error'
            })
            if (idx !== -1) {
              const form = forms[idx].formData
              const index = forms[idx].index
              console.log('发送请求编号：' + idx + '\t状态：' + forms[idx].status)
              max--
              forms[idx].status = 'uploading'
              this.request({
                url: 'http://localhost:3000/upload',
                data: form,
                onProgress: this.createProgressHandler(this.data[index]),
                requestList: this.requestList
              }).then(() => {
                max++
                counter++
                if (counter === len) {
                  res()
                } else {
                  start()
                }
              }).catch(() => {
                retryArr[index] += 1
                max++
                if (retryArr[index] > retryTime) {
                  forms[idx].status = 'fail'
                  this.data.percentage = -1
                  return rej()
                } else {
                  forms[idx].status = 'error'
                }
                console.log('请求失败编号：' + idx)
                start()
              })
            } else {
              break
            }
          }
        }
        start()
      })
    },
    async mergeRequest() {
      await this.request({
        url: 'http://localhost:3000/merge',
        headers: {
          'content-type': 'application/json'
        },
        data: JSON.stringify({
          size: SIZE,
          filename: this.container.file.name,
          hash: this.container.hash
        })
      })
    },
    request({ url, method = 'post', data, headers = {}, onProgress = e => e }) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open(method, url)
        xhr.upload.onprogress = onProgress
        Object.keys(headers).forEach(key =>
          xhr.setRequestHeader(key, headers[key])
        )
        xhr.send(data)
        xhr.onload = e => {
          if (e.target.status === 200) {
            resolve({
              data: e.target.response
            })
          }
          if (e.target.status === 500) {
            reject({
              data: e.target.response
            })
          }
        }
        xhr.onerror = e => {
          console.log('onerror', e)
          reject(e)
        }
      })
    }
  }
}
</script>

<style>
#app {
  font-family: Avenir, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-align: center;
  color: #2c3e50;
  margin-top: 60px;
}
</style>
