// @returns {{promise: Promise<any>; resolve(value: any): void; reject(err: any): void;}}
function deferredPromise() {
  const deferred = {};
  deferred.promise = new Promise((resolve, reject) => {
    deferred.resolve = resolve;
    deferred.reject = reject;
  });
  return deferred;
}

//Get data from the audio for the intiation config
async function extractAudioFileData(audio) {
  const textDecoder = new TextDecoder();
  const buffer = await audio.arrayBuffer();
  if (
    textDecoder.decode(buffer.slice(0, 4)) !== "RIFF" ||
    textDecoder.decode(buffer.slice(8, 12)) !== "WAVE" ||
    textDecoder.decode(buffer.slice(12, 16)) !== "fmt "
  ) {
    throw new Error("Unsupported file format");
  }

  const dataview = new DataView(buffer);
  const fmtSize = dataview.getUint32(16, true);
  let encoding;
  const format = dataview.getUint16(20, true);
  if (format === 1) {
    encoding = "wav/pcm";
  } else if (format === 6) {
    encoding = "wav/alaw";
  } else if (format === 7) {
    encoding = "wav/ulaw";
  } else {
    throw new Error("Unsupported encoding");
  }
  // const channels = dataview.getUint16(22, true);
  const channels = 2;
  const sample_rate = dataview.getUint32(24, true);
  const bit_depth = dataview.getUint16(34, true);

  let nextSubChunk = 16 + 4 + fmtSize;
  while (
    textDecoder.decode(buffer.slice(nextSubChunk, nextSubChunk + 4)) !== "data"
  ) {
    nextSubChunk += 8 + dataview.getUint32(nextSubChunk + 4, true);
  }

  return {
    encoding,
    sample_rate,
    channels,
    bit_depth,
    data: buffer.slice(
      nextSubChunk + 8,
      dataview.getUint32(nextSubChunk + 4, true)
    ),
  };
}

//Set up config for the websocket initiation
function setJsonConfig(
  audioConfig,
  sentimentAnalysisEnabled,
  chapterizationEnabled,
  summarizationEnabled,
  summarizationType,
  callbackEnabled,
  callbackURL
) {
  const config = {
    ...audioConfig,
    realtime_processing: {
      sentiment_analysis: sentimentAnalysisEnabled,
    },
    post_processing: {
      summarization: summarizationEnabled,
      summarization_config: summarizationEnabled
        ? { type: summarizationType }
        : undefined,
      chapterization: chapterizationEnabled,
    },
    callback: callbackEnabled,
  };

  if (callbackEnabled && callbackURL) {
    config.callback_config = {
      url: callbackURL,
      receive_final_transcripts: true,
      receive_partial_transcripts: true,
    };
  }

  return config;
}

async function initiateSession(gladiaKey, config) {
  const response = await fetch(`https://api.gladia.io/v2/live`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GLADIA-KEY": gladiaKey,
    },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    const message = `${response.status}: ${
      (await response.text()) || response.statusText
    }`;
    throw new Error(message);
  }
  return await response.json();
}

//  Starts streaming audio data via WebSocket
async function startStreaming(gladiaKey, audioFile, uiElements) {
  const {
    audioPlayer,
    finalsContainer,
    partialsContainer,
    submitButton,
    sentimentAnalysisEnabled,
    chapterizationEnabled,
    summarizationEnabled,
    summarizationType,
    callbackEnabled,
    callbackURL,
  } = uiElements;

  let socket;
  let config;
  let audioData;
  let audioSrc = URL.createObjectURL(audioFile);

  const stop = () => {
    audioPlayer.pause();
    audioPlayer.src = "";
    URL.revokeObjectURL(audioSrc);
    audioSrc = null;

    submitButton.removeAttribute("disabled");
    submitButton.style.display = "block";
    submitButton.textContent = "Start streaming";

    if (socket) {
      socket.onopen = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.onmessage = null;
      socket.close();
    }
  };

  try {
    const { data, ...rest } = await extractAudioFileData(audioFile);
    audioData = data;
    config = setJsonConfig(
      rest,
      sentimentAnalysisEnabled,
      chapterizationEnabled,
      summarizationEnabled,
      summarizationType,
      callbackEnabled,
      callbackURL
    );

    console.log(config);

    const { url } = await initiateSession(gladiaKey, config);
    const socketPromise = deferredPromise();

    socket = new WebSocket(url);
    socket.onopen = () => {
      socketPromise.resolve(true);
    };
    socket.onerror = () => {
      socketPromise.reject(new Error("Couldn't connect to the server"));
    };
    socket.onclose = (event) => {
      socketPromise.reject(
        new Error(
          `Server refuses the connection: [${event.code}] ${event.reason}`
        )
      );
    };

    await socketPromise.promise;

    socket.onopen = null;
    socket.onerror = null;
    socket.onclose = (event) => {
      if (event.code === 1000) {
        stop();
        return;
      }
      const message = `Lost connection to the server: [${event.code}] ${event.reason}`;
      window.alert(message);
      console.error(message);
      stop();
    };

    socket.onmessage = (event) => {
      handleSocketMessage(event, finalsContainer, partialsContainer, config);
    };

    audioPlayer.src = audioSrc;
    audioPlayer.play();

    await sendAudioChunks(audioData, config, socket);
  } catch (err) {
    window.alert(`Error during streaming: ${err?.message || err}`);
    console.error(err);
    stop();
  }
}

function handleSocketMessage(
  event,
  finalsContainer,
  partialsContainer,
  config
) {
  const message = JSON.parse(event.data);
  console.log(message);

  if (message?.type === "transcript") {
    let prefix = "- ";
    if (config.channels > 1) {
      prefix = `${message.data.utterance.channel}: `;
    }
    if (message.data.is_final) {
      finalsContainer.innerHTML += `<div>${prefix}${message.data.utterance.text}</div>`;
      partialsContainer.textContent = "";
    } else {
      partialsContainer.textContent = `${prefix}${message.data.utterance.text}`;
    }
  } else if (message?.type === "post_summarization") {
    finalsContainer.innerHTML += `<p style="margin-top: 1rem;"><strong>Summarization:</strong> ${message.data.results}</p>`;
  } else if (message?.type === "post_chapterization") {
    let chapterText = `<p style="margin-top: 1rem;"><strong>Chapterization:</strong></p>`;
    if (Array.isArray(message.data.results)) {
      message.data.results.forEach((chapter) => {
        chapterText += `<p>
  <em>Headline:</em> ${chapter.headline}<br>
  <em>Summary:</em> ${chapter.summary}<br>
  <em>Gist:</em> ${chapter.gist}
</p>`;
      });
    } else {
      chapterText += `<p>${message.data.results}</p>`;
    }
    finalsContainer.innerHTML += chapterText;
  }
}

async function sendAudioChunks(audioData, config, socket) {
  const chunkDuration = 50;
  const bytesPerSample = config.bit_depth / 8;
  const bytesPerSecond = config.sample_rate * config.channels * bytesPerSample;
  const chunkSize = Math.round((chunkDuration / 1000) * bytesPerSecond);

  for (let i = 0; i < audioData.byteLength; i += chunkSize) {
    socket.send(audioData.slice(i, i + chunkSize));
    await new Promise((resolve) => setTimeout(resolve, chunkDuration));
  }
  socket.send(JSON.stringify({ type: "stop_recording" }));
}
