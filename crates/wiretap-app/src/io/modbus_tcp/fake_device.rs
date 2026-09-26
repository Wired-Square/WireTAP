use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Notify;

/// One request as the device saw it. `connection` counts accepted sockets from 1.
#[derive(Clone, Debug)]
pub struct Request {
    pub connection: usize,
    pub unit: u8,
    pub pdu: Vec<u8>,
}

impl Request {
    pub fn function(&self) -> u8 {
        self.pdu[0]
    }

    pub fn start(&self) -> u16 {
        u16::from_be_bytes([self.pdu[1], self.pdu[2]])
    }

    pub fn count(&self) -> u16 {
        u16::from_be_bytes([self.pdu[3], self.pdu[4]])
    }
}

pub enum Reply {
    Pdu(Vec<u8>),
    Exception(u8),
    Silent,
    /// Close this connection without answering.
    Drop,
    /// Close this connection and refuse every later one.
    Vanish,
}

pub struct Device {
    pub port: u16,
    requests: Arc<Mutex<Vec<Request>>>,
}

impl Device {
    pub fn requests(&self) -> Vec<Request> {
        self.requests.lock().unwrap().clone()
    }
}

/// A Modbus TCP device on loopback that answers each request with `answer`.
pub async fn device(answer: impl Fn(&Request) -> Reply + Send + Sync + 'static) -> Device {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let answer = Arc::new(answer);
    let gone = Arc::new(Notify::new());
    let seen = requests.clone();
    tokio::spawn(async move {
        let mut connection = 0;
        loop {
            let mut socket = tokio::select! {
                accepted = listener.accept() => accepted.unwrap().0,
                () = gone.notified() => return,
            };
            connection += 1;
            let (seen, answer, gone) = (seen.clone(), answer.clone(), gone.clone());
            tokio::spawn(async move {
                let mut header = [0u8; 7];
                while socket.read_exact(&mut header).await.is_ok() {
                    let length = u16::from_be_bytes([header[4], header[5]]) as usize;
                    let mut pdu = vec![0u8; length - 1];
                    if socket.read_exact(&mut pdu).await.is_err() {
                        return;
                    }
                    let request = Request {
                        connection,
                        unit: header[6],
                        pdu,
                    };
                    seen.lock().unwrap().push(request.clone());
                    let reply = match answer(&request) {
                        Reply::Pdu(pdu) => pdu,
                        Reply::Exception(code) => vec![request.function() | 0x80, code],
                        Reply::Silent => continue,
                        Reply::Drop => return,
                        Reply::Vanish => {
                            gone.notify_one();
                            return;
                        }
                    };
                    let mut adu = header[..4].to_vec();
                    adu.extend((reply.len() as u16 + 1).to_be_bytes());
                    adu.push(header[6]);
                    adu.extend(reply);
                    if socket.write_all(&adu).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    Device { port, requests }
}

/// FC03/FC04 answered with each register holding its own address; FC06/FC16
/// acknowledged.
pub fn registers(request: &Request) -> Reply {
    let pdu = &request.pdu;
    match request.function() {
        0x03 | 0x04 => {
            let mut reply = vec![pdu[0], (request.count() * 2) as u8];
            for register in request.start()..request.start() + request.count() {
                reply.extend(register.to_be_bytes());
            }
            Reply::Pdu(reply)
        }
        0x06 | 0x10 => Reply::Pdu(pdu[..5].to_vec()),
        _ => Reply::Exception(0x01),
    }
}
