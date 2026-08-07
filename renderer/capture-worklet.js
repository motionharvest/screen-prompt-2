// Ships each render quantum of mono samples to the overlay for buffering.
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      this.port.postMessage(new Float32Array(channel));
    }
    return true;
  }
}
registerProcessor('capture', CaptureProcessor);
