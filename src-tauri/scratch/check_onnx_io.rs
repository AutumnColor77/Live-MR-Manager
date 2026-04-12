use ort::session::Session;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    ort::init().commit()?;

    println!("--- Encoder Model ---");
    let encoder = Session::builder()?.commit_from_file("f:/Live-MR-Manager/src-tauri/models/encoder_model_q4.onnx")?;
    for input in &encoder.inputs {
        println!("Input: {}", input.name);
    }
    for output in &encoder.outputs {
        println!("Output: {}", output.name);
    }

    println!("\n--- Decoder Model ---");
    let decoder = Session::builder()?.commit_from_file("f:/Live-MR-Manager/src-tauri/models/decoder_model_merged_q4.onnx")?;
    for input in &decoder.inputs {
        println!("Input: {}", input.name);
    }
    for output in &decoder.outputs {
        println!("Output: {}", output.name);
    }

    Ok(())
}
