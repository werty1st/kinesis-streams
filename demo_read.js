// Usage: node demo.js [streamName]

const AWS = require('aws-sdk')
AWS.config.update({region: "eu-west-1"});
const { KinesisReadable } = require('./lib/index')

const KINSTREAM = process.env.STREAM;

// setTimeout(() => this.push(data), WAIT * 1.1 * Math.random())

const client = new AWS.Kinesis()
const stream = new KinesisReadable(client, KINSTREAM || 'demo', { /*parser: JSON.parse,*/ limit: 500})

stream.on('data', (response) => {
  /* eslint-disable no-unused-vars */
  //console.log("Kinesis stream data:",response);
  /* eslint-enable */
})

//SequenceNumber <=> checkpoint

stream.on('checkpoint', (response) => {
  /* eslint-disable no-unused-vars */
  console.log("Kinesis checkpoint:",response);
  /* eslint-enable */
})

stream.on('resharding', () => {
    /* eslint-disable no-unused-vars */
    console.log("Kinesis reshard:");
    /* eslint-enable */
  })

stream.on('error', (e) => {
  /* eslint-disable no-unused-vars */
  console.error("Kinesis error.",e);
  /* eslint-enable */
})
