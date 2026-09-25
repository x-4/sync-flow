'use strict';

const createChannelStream = require('./lib/duplex-bridge');
const extension = require('./lib/option-negotiator');
const PayloadCompressor = require('./lib/payload-compressor');
const FrameDecoder = require('./lib/frame-decoder');
const FrameEncoder = require('./lib/frame-encoder');
const subprotocol = require('./lib/subprotocol-picker');
const Channel = require('./lib/channel');
const ChannelHub = require('./lib/channel-hub');

Channel.createChannelStream = createChannelStream;
Channel.extension = extension;
Channel.PayloadCompressor = PayloadCompressor;
Channel.FrameDecoder = FrameDecoder;
Channel.FrameEncoder = FrameEncoder;
Channel.Server = ChannelHub;
Channel.subprotocol = subprotocol;
Channel.Channel = Channel;
Channel.ChannelHub = ChannelHub;

module.exports = Channel;
