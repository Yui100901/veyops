use std::env;
use std::error::Error;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::time::Duration;

const HEALTH: &str = "{\"status\":\"ok\",\"language\":\"rust\"}\n";

fn main() -> Result<(), Box<dyn Error>> {
    let port = env::var("PORT")
        .unwrap_or_else(|_| "8080".into())
        .parse::<u16>()?;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))?;
    for connection in listener.incoming() {
        if let Err(error) = connection.and_then(handle) {
            eprintln!("HTTP connection: {error}");
        }
    }
    Ok(())
}

fn handle(mut stream: TcpStream) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;

    let mut request = String::new();
    let mut reader = BufReader::new((&mut stream).take(8192));
    if reader.read_line(&mut request)? == 0 {
        return Ok(());
    }
    let mut header = String::new();
    loop {
        if reader.read_line(&mut header)? == 0 {
            return Ok(());
        }
        if header == "\r\n" {
            break;
        }
        header.clear();
    }

    let mut parts = request.split_ascii_whitespace();
    let method = parts.next();
    let path = parts.next().and_then(|url| url.split('?').next());
    let version = parts.next();
    let (status, body, extra_headers) = match (method, path, version, parts.next()) {
        (Some("GET"), Some("/healthz"), Some("HTTP/1.0" | "HTTP/1.1"), None) => {
            ("200 OK", HEALTH, "Content-Type: application/json\r\n")
        }
        (Some(_), Some("/healthz"), Some("HTTP/1.0" | "HTTP/1.1"), None) => {
            ("405 Method Not Allowed", "", "Allow: GET\r\n")
        }
        (Some(_), Some(_), Some("HTTP/1.0" | "HTTP/1.1"), None) => ("404 Not Found", "", ""),
        _ => ("400 Bad Request", "", ""),
    };
    write!(
        stream,
        "HTTP/1.1 {status}\r\n{extra_headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}
