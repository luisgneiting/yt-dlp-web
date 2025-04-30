import { spawn } from 'child_process';
import type { FFmpegStreamsJson, Streams } from '@/types/video';

export class FFmpegHelper {
  public readonly filePath;
  public readonly fileUuid;

  constructor(params: { filePath: string; fileUuid?: string }) {
    this.filePath = params.filePath;
    this.fileUuid = params.fileUuid;
  }

  async getVideoStreams() {
    if (!this.filePath) {
      return;
    }

    const ffprobe = spawn('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,color_primaries,r_frame_rate,codec_name,duration',
      '-of',
      'json',
      this.filePath
    ]);

    let stdoutChunks = '';

    ffprobe.stdout.setEncoding('utf-8');
    ffprobe.stdout.on('data', (data) => {
      const text = data?.trim?.();
      if (text) stdoutChunks += text;
    });

    return new Promise((resolve: (streams: Streams) => void, reject: (message: string) => void) => {
      ffprobe.stderr.setEncoding('utf-8');
      ffprobe.stderr.on('data', (data) => {
        return reject(data?.trim?.() || '');
      });
      ffprobe.on('exit', () => {
        try {
          if (!stdoutChunks) {
            throw 'streams not found';
          }
          const json = JSON.parse(stdoutChunks) as FFmpegStreamsJson;
          const streams = json?.streams?.[0];

          if (!streams) {
            throw 'streams not found';
          }

          const [total, duration] = streams?.r_frame_rate?.split?.('/') || [];
          resolve({
            codecName: streams.codec_name,
            width: streams.width,
            height: streams.height,
            colorPrimaries: streams.color_primaries,
            rFrameRate:
              total && duration ? Number(total) / Number(duration) || undefined : undefined,
            duration: streams.duration
          });
        } catch (e) {
          reject('streams not found');
        }
      });
    });
  }

  async repair() {
  console.log("[FFmpegHelper] Iniciando reparo com ffmpeg:", this.filePath);
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      `ffmpeg -y -loglevel repeat+info -i "file:${this.filePath}" -map 0 -dn -ignore_unknown -c:v libx264 -preset slow -crf 20 -f mp4 -bsf:a aac_adtstoasc -movflags +faststart "file:${this.filePath}.temp" && rm "${this.filePath}" && mv "${this.filePath}.temp" "${this.filePath}"`,
      { shell: true }
    );

    ffmpeg.stderr.on('data', (data) => {
      console.error(`[ffmpeg error]: ${data}`);
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        console.log("[FFmpegHelper] Vídeo convertido com sucesso.");
        resolve(undefined);
      } else {
        reject(new Error(`[FFmpegHelper] ffmpeg falhou com código ${code}`));
      }
    });
  });
}

}
