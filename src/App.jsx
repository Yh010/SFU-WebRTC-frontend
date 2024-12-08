import { useState } from 'react';
import io from 'socket.io-client';
import { Device } from 'mediasoup-client';

const App = () => {
  const [socket, setSocket] = useState(null);
  const [device, setDevice] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);

  const connectServer = async () => {
    const serverUrl = `ws://localhost:3000`;
    const newSocket = io(serverUrl, { path: '/server', transports: ['websocket'] });

    // Extend socket to support promises
   newSocket.request = (type, data = {}) => {
  return new Promise((resolve, reject) => {
    newSocket.emit(type, data, (response) => {
      if (response?.error) {
        reject(response.error);
      } else {
        resolve(response);
      }
    });
  });
};


    setSocket(newSocket);

    newSocket.on('connect', async () => {
      console.log('Connected to server');
      const routerRtpCapabilities = await newSocket.request('getRouterRtpCapabilities');
      const newDevice = new Device();
      await newDevice.load({ routerRtpCapabilities });
      setDevice(newDevice);
    });

    newSocket.on('disconnect', () => {
      console.log('Disconnected from server');
    });

    newSocket.on('newProducer', () => {
      console.log('New producer detected');
      subscribeStream();
    });
  };

  const publishStream = async () => {
    if (!device) return;

    const data = await socket.request('createProducerTransport');
    const transport = device.createSendTransport(data);

    transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      socket.request('connectProducerTransport', { dtlsParameters }).then(callback).catch(errback);
    });

    transport.on('produce', async ({ kind, rtpParameters }, callback) => {
      const { id } = await socket.request('produce', { kind, rtpParameters });
      callback({ id });
    });

    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const track = stream.getVideoTracks()[0];
    await transport.produce({ track });
  };

  const subscribeStream = async () => {
    if (!device) return;

    const data = await socket.request('createConsumerTransport');
    const transport = device.createRecvTransport(data);

    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      socket.request('connectConsumerTransport', { dtlsParameters }).then(callback).catch(errback);
    });

    transport.on('connectionstatechange', async (state) => {
      if (state === 'connected') {
        console.log('Connected to consumer transport');
      }
    });

    const { id, kind, rtpParameters } = await socket.request('consume', { rtpCapabilities: device.rtpCapabilities });
    const consumer = await transport.consume({
      id,
      producerId: id,
      kind,
      rtpParameters,
    });

    const stream = new MediaStream();
    stream.addTrack(consumer.track);
    setRemoteStream(stream);

    await socket.request('resume');
  };

  return (
    <div>
      <h1>SFU-Based WebRTC App</h1>
      <button onClick={connectServer}>Connect</button>
      <button onClick={publishStream}>Publish</button>
      <button onClick={subscribeStream}>Subscribe</button>

      <div>
        <h2>Local Video</h2>
        <video autoPlay playsInline muted id="localVideo"></video>
      </div>

      <div>
        <h2>Remote Video</h2>
        <video
          autoPlay
          playsInline
          ref={(video) => {
            if (video && remoteStream) {
              video.srcObject = remoteStream;
            }
          }}
        ></video>
      </div>
    </div>
  );
};

export default App;
