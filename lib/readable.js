// @flow weak
// http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/Kinesis.html
const Readable = require('stream').Readable
const debug = require('debug')('kinesis-streams:readable')
const debugreshard = require('debug')('kinesis-streams:readable:reshard')

function sleep (timeout, ...args) {
  if (timeout === 0) {
    return Promise.resolve(...args)
  }

  return new Promise((resolve) => {
    setTimeout(() => resolve(...args), timeout)
  })
}

function getStreams (client) {
  return client.listStreams({}).promise()
}



class KinesisReadable extends Readable {
  /*:: client: Object */
  /*:: logger: {debug: Function, info: Function, warn: Function} */
  /*:: options: Object */
  /*:: streamName: string */
  /*:: _started: 0|1|2 */
  /*:: iterators: Set<string> */
  constructor (client/*: Object */, streamName/*: string */, options = {}) {
    if (!client) {
      throw new Error('client is required')
    }
    if (!streamName) {
      throw new Error('streamName is required')
    }

    super({objectMode: true})

    this.client = client
    this.streamName = streamName
    this.logger = options.logger || {debug: debug, info: debug, warn: debug}
    this.options = Object.assign({
      // idleTimeBetweenReadsInMillis  http://docs.aws.amazon.com/streams/latest/dev/kinesis-low-latency.html
      interval: 2000,
      parser: (x) => x,
    }, options)
    this._started = 0 // TODO this is probably built into Streams
    this.iterators = new Set()

    this.liveShards = new Set();
    this._monitorInterval = false;

    //TODO merge liveShards functionality into this.shards
    this.shards = function(parent) {
      var iterators = { /* key:iterator value:shardId*/ };
      var shards    = { /* key:shardId  value:iterator*/ };
      return {
        add: function(shardId/*: string */, iterator/*: string */){
          debugreshard("add shard:",shardId);
          shards[shardId] = iterator;
          iterators[iterator] = shardId;
        },
        update: function(oldIterator, newIterator){
          debugreshard("update shard:",iterators[oldIterator]);
          shards[iterators[oldIterator]] = newIterator;
          iterators[newIterator] = iterators[oldIterator];
          delete iterators[oldIterator];
        },
        getShardByIterator(iterator){
          return iterators[iterator]
        },
        close: function(shardId/*: string */){
          debugreshard("close shard:",shardId);          
          delete iterators[shards[shardId]];
          shards[shardId] = false;

          if ( parent.liveShards.has(shardId) ){
            parent.liveShards.delete(shardId);
            parent.reshard();            
          }
            
        },
        getActiveShards(){
          return Object.keys(shards).map(shardId=>{ return shards[shardId]!==false?shardId:[] }).filter( item=>item!="")
        },        
        getInactiveShards(){
          return Object.keys(shards).map(shardId=>{ return shards[shardId]==false?shardId:[] }).filter( item=>item!="")
          //return Object.values(shards).filter(v=>v==false);
        }

      }
    }(this)
  }

  getShardId () {
    const params = {
      StreamName: this.streamName,
    }
    return this.client.describeStream(params).promise()
      .then((data) => {
        if (!data.StreamDescription.Shards.length) {
          throw new Error('No shards!') // _startKinesis will catch this and emit the error
        }
        this.logger.info('getShardId found %d shards', data.StreamDescription.Shards.length)
        
        //seperate old shards from live shards
        data.StreamDescription.Shards.map( (shard)=>{
          this.liveShards.add(shard.ShardId);          
          //remove Shard if it has a successor 
          if(this.liveShards.has(shard.ParentShardId))
            this.liveShards.delete(shard.ParentShardId)
          
          if(this.liveShards.has(shard.AdjacentParentShardId))
            this.liveShards.delete(shard.AdjacentParentShardId)            
        })

        return data.StreamDescription.Shards.map((x) => x.ShardId)
      })
  }

  getShardIterator (shardId/*: string */, options/*: Object */) {
    const params = Object.assign({
      ShardId: shardId,
      ShardIteratorType: 'LATEST',
      StreamName: this.streamName,
    }, options || {})
    return this.client.getShardIterator(params).promise()
      .then((data) => {
        this.logger.info('getShardIterator got iterator id: %s', data.ShardIterator)
        this.shards.add(shardId,data.ShardIterator);
        return data.ShardIterator
      })
  }


  _getStreamSummary () {
    const params = {
      StreamName: this.streamName,
    }
    return new Promise((resolve,reject)=>{
      this.client.describeStreamSummary(params,(err,data)=>{
        //Store stream summary
        resolve(data.StreamDescriptionSummary);
      })
      setTimeout(reject,2000);
    })
    
  }

  _startMonitorStream(){
    if (this._monitorInterval) return //dont run multiple times

    this._monitorInterval = setInterval(()=>{    
      this._getStreamSummary().then(stream=>{
        
        switch (stream.StreamStatus) {
          case "UPDATING":
          case "CREATING":
            //wait          
            break;
        
          case "ACTIVE":
            debugreshard("ACTIVE");  
            if ( this.shards.getActiveShards.length != stream.OpenShardCount){
              //split or merge occured
              //re-iterate shards
              let shardIdsToSkip = Array.from(this.liveShards).concat( this.shards.getInactiveShards() )
              this._startKinesis(shardIdsToSkip)
              this.emit("resharding")
            }
            this._stopMonitorStream();            
            break;

          case "DELETING":
          //unknow or unusable state => shutdown    
          this._stopMonitorStream();        
        
          default:
            break;
        }
      })
    },1000)
  }
  
  _stopMonitorStream(){
    clearInterval(this._monitorInterval)
    this._monitorInterval = false
  }


  _startKinesis (shardIdsToSkip=[]) {

    const whitelist = ['ShardIteratorType', 'Timestamp', 'StartingSequenceNumber']
    const shardIteratorOptions = Object.keys(this.options)
      .filter((x) => whitelist.indexOf(x) !== -1)
      .reduce((result, key) => Object.assign(result, {[key]: this.options[key]}), {})
    return this.getShardId()
      .then((shardIds) => {

        //recall funtion after reshard (asymetric reshard keeps some shards running so skip these)
        shardIds = shardIds.filter(shardId=>!shardIdsToSkip.includes(shardId))
        debugreshard({"_startKinesis": shardIds})

        const shardIterators = shardIds.map((shardId) => 
          this.getShardIterator(shardId, shardIteratorOptions))
        return Promise.all(shardIterators)
      })
      .then((shardIterators) => {
        shardIterators.forEach((shardIterator) => this.readShard(shardIterator))
      })
      .catch((err) => {
        this.emit('error', err) || console.log(err, err.stack)
      })


  }

  //RESHARD
  reshard(){
    debugreshard("trigger reshard");
    this._startMonitorStream()   
  }


  readShard (shardIterator/*: string */) {
    this.iterators.add(shardIterator)
    this.logger.info('readShard starting from %s (out of %d)', shardIterator, this.iterators.size)
    const params = {
      ShardIterator: shardIterator,
      Limit: 10000, // https://github.com/awslabs/amazon-kinesis-client/issues/4#issuecomment-56859367
    }
    // This will be a lot cleaner with async/await
    return this.client.getRecords(params).promise()
      .then((data) => {
        if (data.MillisBehindLatest > 60 * 1000) {
          this.logger.warn('behind by %d milliseconds', data.MillisBehindLatest)
        }
        data.Records.forEach((x) => this.push(this.options.parser(x.Data)))
        if (data.Records.length) {
          this.emit('checkpoint', data.Records[data.Records.length - 1].SequenceNumber)
        }
        this.iterators.delete(shardIterator)
        if (!data.NextShardIterator) {
          this.logger.info('readShard.closed %s', shardIterator)
          // TODO this.end() when number of shards closed == number of shards being read
          // TODO Adapting to a Reshard (https://docs.aws.amazon.com/streams/latest/dev/developing-consumers-with-sdk.html)
          this.shards.close( this.shards.getShardByIterator(shardIterator) );          
          return null
        }
        //update iterator
        this.shards.update(shardIterator, data.NextShardIterator);

        return data.NextShardIterator
      })
      .then((nextShardIterator) => {
        if (nextShardIterator) {
          return sleep(this.options.interval, nextShardIterator)
        }

        return null
      })
      .then((nextShardIterator) => {
        if (nextShardIterator) {
          return this.readShard(nextShardIterator)
        }

        return null
      })
      .catch((err) => {
        this.emit('error', err)
        return null
      })
  }

  _read (size/*: number|void */) {
    if (this._started) {
      return
    }

    this._startKinesis()
      .then(() => {
        this._started = 2
      })
      .catch((err) => {
        this.emit('error', err) || console.log(err, err.stack)
      })
    this._started = 1
  }
}


// EXPORTS
//////////

exports.getStreams = getStreams
exports.KinesisReadable = KinesisReadable
