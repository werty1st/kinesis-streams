#!/bin/bash

#AWS Kinesis
#===========

STREAMNAME=test-stream

SHARDS=$(
aws kinesis list-shards \
    --stream-name $STREAMNAME \
    --output json \
    | jq -r '.Shards | .[].ShardId' # list 
    #| jq '[.Shards | .[].ShardId]'  # json array
)

#string to array
SHARDSA=($SHARDS)
SHARDSA=("shardId-000000000010")

#get shard-iterators
SIS=$(
for SHARDID in "${SHARDSA[@]}"
do
    aws kinesis get-shard-iterator \
        --stream-name $STREAMNAME \
        --shard-id $SHARDID \
        --shard-iterator-type AFTER_SEQUENCE_NUMBER \
        --starting-sequence-number 49588647106877340369134683608185456342991749338078642338
        #--shard-iterator-type TRIM_HORIZON
done
)





SISA=($SIS)
for SI in "${SISA[@]}"
do
    echo "Starting with SI"
    aws kinesis get-records \
        --output json \
        --shard-iterator "$SI"
    echo "Done with SI"
done
#create json array of all ShardIterators
#jq -n --arg input "$SIS" '$input | split("\n")'


# aws kinesis get-records \
#     --output json \
#     --shard-iterator "AAAAAAAAAAE1lGj2vZV0eiye+NQDSvsTlpDzTyTUNbDpvk9VsaUzHwHbg6R4GsPrO09aHgtPQDtvQHzSffbsg9A46xO8hbFg1aELg6WZS2zKnUqccZf17ygBsvptvSNi3h5mCA7yZd1biY5t1frQ6k5fLpdXOLlYkU2TeTkqAgbmFDtwzbc+haahmLoA25EbhlhmX4JU2tJ+e1tS6VnTjvGAbtAr2smC"


aws kinesis describe-stream \
    --output json \
    --stream-name $STREAMNAME


aws kinesis describe-stream-summary \
    --output json \
    --stream-name $STREAMNAME

exit 0


SHARDSA=("shardId-000000000012" "shardId-000000000013")

aws kinesis merge-shards \
    --output json \
    --stream-name $STREAMNAME \
    --shard-to-merge ${SHARDSA[0]} \
    --adjacent-shard-to-merge ${SHARDSA[1]}


aws kinesis split-shard \
    --output json \
    --stream-name $STREAMNAME \
    --shard-to-split "shardId-000000000011" \
    --new-starting-hash-key "$(bc <<< 340282366920938463463374607431768211455/2)"


#
