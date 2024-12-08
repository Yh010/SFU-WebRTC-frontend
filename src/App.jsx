import { useState, useRef, useEffect } from 'react';
import { io } from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';
import socketPromise from './lib/socket.io-promise';

const App = () => {
  const [connectionStatus, setConnectionStatus] = useState('');
  const [webcamStatus, setWebcamStatus] = useState('');
  const [screenStatus, setScreenStatus] = useState('');
  const [subscriptionStatus, setSubscriptionStatus] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [useSimulcast, setUseSimulcast] = useState(false);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);

  const socketRef = useRef(null);
  const deviceRef = useRef(null);
  const producerRef = useRef(null);

  const config = {
    serverUrl: 'http://localhost:3000', // Update with your actual server URL
    socketPath: '/server'
  };


  useEffect(() => {
    // Check screen share support
    if (typeof navigator.mediaDevices.getDisplayMedia === 'undefined') {
      setScreenStatus('Not supported');
    }
  }, []);

  const connect = async () => {
    //const hostname = window.location.hostname;
    // const serverUrl = `http:localhost:3000`;

    // const opts = {
    //   path: '/server',
    //   transports: ['websocket'],
    // };

    try {
      const socket = io(config.serverUrl, {
        path: config.socketPath,
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000
      });
      socketRef.current = socket;
      socket.request = socketPromise(socket);

      socket.on('connect', async () => {
        console.log('Socket connected successfully');
        setConnectionStatus('Connected');
        setIsConnected(true);

        try {
          const data = await socket.request('getRouterRtpCapabilities');
          await loadDevice(data);
        } catch (error) {
          console.error('Error getting router RTP capabilities:', error);
        }
      });

      socket.on('disconnect', (reason) => {
        console.log('Socket disconnected:', reason);
        setConnectionStatus('Disconnected');
        setIsConnected(false);
      });

      socket.on('connect_error', (error) => {
        console.error('Connection error:', error);
        setConnectionStatus(`Connection failed: ${error.message}`);
      });

      socket.on('newProducer', () => {
        // Handle new producer event if needed
        console.log('New producer available');
      });
    } catch (error) {
      console.error('Connection error:', error);
      setConnectionStatus('Connection failed');
    }
  };

  const loadDevice = async (routerRtpCapabilities) => {
    try {
      const device = new mediasoupClient.Device();
      await device.load({ routerRtpCapabilities });
      deviceRef.current = device;
    } catch (error) {
      if (error.name === 'UnsupportedError') {
        console.error('Browser not supported');
      }
    }
  };

  const publish = async (isWebcam) => {
    const socket = socketRef.current;
    const device = deviceRef.current;

    const setStatus = isWebcam ? setWebcamStatus : setScreenStatus;

    try {
      const data = await socket.request('createProducerTransport', {
        forceTcp: false,
        rtpCapabilities: device.rtpCapabilities,
      });

      if (data.error) {
        console.error(data.error);
        return;
      }

      const transport = device.createSendTransport(data);

      transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        socket.request('connectProducerTransport', { dtlsParameters })
          .then(callback)
          .catch(errback);
      });

      transport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
        try {
          const { id } = await socket.request('produce', {
            transportId: transport.id,
            kind,
            rtpParameters,
          });
          callback({ id });
        } catch (err) {
          errback(err);
        }
      });

      transport.on('connectionstatechange', (state) => {
        switch (state) {
          case 'connecting':
            setStatus('Publishing...');
            break;
          case 'connected':
            setStatus('Published');
            break;
          case 'failed':
            transport.close();
            setStatus('Failed');
            break;
        }
      });

      const stream = await getUserMedia(device, isWebcam);
      const track = stream.getVideoTracks()[0];
      const params = { track };

      if (useSimulcast) {
        params.encodings = [
          { maxBitrate: 100000 },
          { maxBitrate: 300000 },
          { maxBitrate: 900000 },
        ];
        params.codecOptions = {
          videoGoogleStartBitrate: 1000
        };
      }

      const producer = await transport.produce(params);
      producerRef.current = producer;

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
    } catch (err) {
      console.error('Publish error:', err);
      setStatus('Failed');
    }
  };

  const getUserMedia = async (device, isWebcam) => {
    if (!device.canProduce('video')) {
      throw new Error('Cannot produce video');
    }

    try {
      const stream = isWebcam
        ? await navigator.mediaDevices.getUserMedia({ video: true })
        : await navigator.mediaDevices.getDisplayMedia({ video: true });
      return stream;
    } catch (err) {
      console.error('getUserMedia() failed:', err.message);
      throw err;
    }
  };

  const subscribe = async () => {
    const socket = socketRef.current;
    const device = deviceRef.current;

    try {
      const data = await socket.request('createConsumerTransport', {
        forceTcp: false,
      });

      if (data.error) {
        console.error(data.error);
        return;
      }

      const transport = device.createRecvTransport(data);

      transport.on('connect', ({ dtlsParameters }, callback, errback) => {
        socket.request('connectConsumerTransport', {
          transportId: transport.id,
          dtlsParameters
        })
          .then(callback)
          .catch(errback);
      });

      transport.on('connectionstatechange', async (state) => {
        switch (state) {
          case 'connecting':
            setSubscriptionStatus('Subscribing...');
            break;
          case 'connected':
            { const stream = await consume(transport);
            if (remoteVideoRef.current) {
              remoteVideoRef.current.srcObject = stream;
            }
            await socket.request('resume');
            setSubscriptionStatus('Subscribed');
            break; }
          case 'failed':
            transport.close();
            setSubscriptionStatus('Failed');
            break;
        }
      });

      await consume(transport);
    } catch (error) {
      console.error('Subscribe error:', error);
      setSubscriptionStatus('Failed');
    }
  };

  const consume = async (transport) => {
    const socket = socketRef.current;
    const device = deviceRef.current;
    const { rtpCapabilities } = device;

    const data = await socket.request('consume', { rtpCapabilities });
    const {
      producerId,
      id,
      kind,
      rtpParameters,
    } = data;

    const consumer = await transport.consume({
      id,
      producerId,
      kind,
      rtpParameters,
      codecOptions: {},
    });

    const stream = new MediaStream();
    stream.addTrack(consumer.track);
    return stream;
  };

  return (
    <div className="container p-4">
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <div>Local</div>
          <video 
            ref={localVideoRef} 
            controls 
            autoPlay 
            playsInline 
            className="w-full"
          />
        </div>
        <div>
          <div>Remote</div>
          <video 
            ref={remoteVideoRef} 
            controls 
            autoPlay 
            playsInline 
            className="w-full"
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <fieldset className="border p-2">
          <legend className="px-2">Connection</legend>
          <div>
            <button 
              onClick={connect} 
              disabled={isConnected}
              className="bg-blue-500 text-white px-4 py-2 rounded mr-2"
            >
              Connect
            </button>
            <span>{connectionStatus}</span>
          </div>
        </fieldset>

        <fieldset className="border p-2" disabled={!isConnected}>
          <legend className="px-2">Publishing</legend>
          <div className="mb-2">
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={useSimulcast}
                onChange={(e) => setUseSimulcast(e.target.checked)}
                className="mr-2"
              />
              Use Simulcast
            </label>
          </div>
          <div className="mb-2">
            <button 
              onClick={() => publish(true)} 
              className="bg-green-500 text-white px-4 py-2 rounded mr-2"
            >
              Start Webcam
            </button>
            <span>{webcamStatus}</span>
          </div>
          <div>
            <button 
              onClick={() => publish(false)} 
              className="bg-green-500 text-white px-4 py-2 rounded mr-2"
            >
              Share Screen
            </button>
            <span>{screenStatus}</span>
          </div>
        </fieldset>

        <fieldset className="border p-2" disabled={!isConnected}>
          <legend className="px-2">Subscription</legend>
          <div>
            <button 
              onClick={subscribe} 
              className="bg-purple-500 text-white px-4 py-2 rounded mr-2"
            >
              Subscribe
            </button>
            <span>{subscriptionStatus}</span>
          </div>
        </fieldset>
      </div>
    </div>
  );
};

export default App;